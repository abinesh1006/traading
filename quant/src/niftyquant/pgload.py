"""Copy the curated Parquet store into Postgres.

The schema belongs to the backend (Flyway migrations in backend/src/main/resources/db/migration);
this module only writes rows. Each run sends days that are new or were re-fetched since the last
load (tracked in load_log), then replaces the small derived tables and the trading calendar.

Postgres listens only on the server's localhost, so connections go through an SSH port-forward.
If something already listens on the local port (the dev.ps1 tunnel window), that is reused;
otherwise a tunnel is opened for the duration of the run.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from itertools import groupby
from pathlib import Path

import pandas as pd
import psycopg
from psycopg import sql

from . import analytics, events, greeks, premiums, store
from .ingest import ALL_DATASETS
from .store import Manifest

log = logging.getLogger(__name__)

TABLES = {
    "fo_bhavcopy": "fo_eod",
    "index_close": "index_eod",
    "participant_oi": "participant_oi",
    "participant_vol": "participant_vol",
}
GREEKS_TABLE = "option_greeks"  # per-day derived files, versioned by file time
DERIVED = {"daily_market": analytics.DAILY_MARKET, "participants_daily": analytics.PARTICIPANTS,
           "iv_daily": analytics.IV_DAILY, "moneyness_daily": premiums.FILE,
           "market_events": events.FILE, "event_impact": events.IMPACT_FILE}
COPY_CHUNK = 200_000


@dataclass(frozen=True)
class PgSettings:
    db: str
    user: str
    password: str
    host: str = "localhost"      # as seen from the SSH server when ssh_host is set
    port: int = 5432
    ssh_host: str | None = None  # e.g. ubuntu@api.example.com; None = connect directly
    local_port: int = 15432      # local end of the SSH port-forward
    sslmode: str = "prefer"

    @classmethod
    def from_env(cls) -> PgSettings | None:
        """Settings from PG_* variables (the repo .env is loaded by config). None if not configured."""
        e = os.environ
        if not e.get("PG_DB") or not e.get("PG_USER"):
            return None
        return cls(db=e["PG_DB"], user=e["PG_USER"], password=e.get("PG_PASSWORD", ""),
                   host=e.get("PG_HOST", "localhost"), port=int(e.get("PG_PORT", "5432")),
                   ssh_host=e.get("PG_SSH_HOST") or None,
                   local_port=int(e.get("PG_LOCAL_PORT", "15432")),
                   sslmode=e.get("PG_SSLMODE", "prefer"))

    @property
    def endpoint(self) -> tuple[str, int]:
        return ("127.0.0.1", self.local_port) if self.ssh_host else (self.host, self.port)


def _listening(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


@contextmanager
def tunnel(s: PgSettings, timeout: float = 20.0):
    """SSH port-forward local_port -> host:port on ssh_host, unless one is already open."""
    if not s.ssh_host or _listening(s.local_port):
        yield
        return
    cmd = ["ssh", "-N", "-C", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
           "-o", "ServerAliveInterval=30", "-L", f"{s.local_port}:{s.host}:{s.port}", s.ssh_host]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + timeout
        while not _listening(s.local_port):
            if proc.poll() is not None:
                err = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
                raise RuntimeError(f"SSH tunnel to {s.ssh_host} failed: {err}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"SSH tunnel to {s.ssh_host} did not open within {timeout:.0f}s")
            time.sleep(0.2)
        log.info("SSH tunnel open: 127.0.0.1:%d -> %s:%d via %s", s.local_port, s.host, s.port, s.ssh_host)
        yield
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def connect(s: PgSettings) -> psycopg.Connection:
    # autocommit: each `with conn.transaction()` block is then its own BEGIN/COMMIT, not a savepoint
    # inside one run-long transaction.
    host, port = s.endpoint
    return psycopg.connect(host=host, port=port, dbname=s.db, user=s.user, password=s.password,
                           sslmode=s.sslmode, connect_timeout=15, application_name="niftyquant-loader",
                           autocommit=True)


def require_schema(conn: psycopg.Connection) -> None:
    missing = [t for t in [*TABLES.values(), GREEKS_TABLE, *DERIVED, "trading_calendar", "load_log"]
               if conn.execute("select to_regclass(%s)", (f"public.{t}",)).fetchone()[0] is None]
    if missing:
        raise RuntimeError(
            f"tables missing in Postgres: {', '.join(missing)}. Start the backend once "
            "(cd backend; mvn spring-boot:run): its Flyway migrations create the schema.")


def copy_frame(conn: psycopg.Connection, table: str, df: pd.DataFrame) -> None:
    """COPY a frame into a table by column name. NaN/NA become NULL (empty unquoted CSV field)."""
    stmt = sql.SQL("COPY {} ({}) FROM STDIN (FORMAT csv)").format(
        sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, df.columns)))
    with conn.cursor() as cur, cur.copy(stmt) as cp:
        for i in range(0, len(df), COPY_CHUNK):
            cp.write(df.iloc[i:i + COPY_CHUNK].to_csv(index=False, header=False, lineterminator="\n"))


def manifest_versions(manifest: pd.DataFrame, dataset: str) -> dict[date, datetime]:
    """Version of each downloaded day = when it was fetched (a re-fetch makes it newer)."""
    ok = manifest[(manifest["dataset"] == dataset) & (manifest["status"] == "ok")]
    return {d: datetime.fromisoformat(f) for d, f in zip(ok["trade_date"].dt.date, ok["fetched_at"])}


def file_versions(root: Path) -> dict[date, datetime]:
    """Version of each per-day derived file = its modification time (UTC, microseconds)."""
    return {date.fromisoformat(p.stem): datetime.fromtimestamp(p.stat().st_mtime, timezone.utc)
            for p in root.glob("year=*/*.parquet")}


def pending_days(versions: dict[date, datetime], loaded: dict) -> list[tuple]:
    """(trade_date, version) for days never loaded or changed since they were loaded."""
    return sorted((d, v) for d, v in versions.items() if loaded.get(d) != v)


def load_dataset(conn: psycopg.Connection, dataset: str, table: str, versions: dict[date, datetime],
                 read_day: Callable[[date], pd.DataFrame], reload: bool = False) -> int:
    """Send pending days for one dataset, one transaction per year. Returns days loaded."""
    loaded = {} if reload else dict(conn.execute(
        "select trade_date, source_fetched_at from load_log where dataset = %s", (dataset,)).fetchall())
    todo = pending_days(versions, loaded)
    for year, group in groupby(todo, key=lambda x: x[0].year):
        days = list(group)
        frames = [read_day(d) for d, _ in days]
        df = pd.concat(frames, ignore_index=True)
        with conn.transaction():
            conn.execute(sql.SQL("delete from {} where trade_date = any(%s)").format(sql.Identifier(table)),
                         ([d for d, _ in days],))
            copy_frame(conn, table, df)
            with conn.cursor() as cur:
                cur.executemany(
                    """insert into load_log (dataset, trade_date, rows, source_fetched_at)
                       values (%s, %s, %s, %s)
                       on conflict (dataset, trade_date) do update
                       set rows = excluded.rows, source_fetched_at = excluded.source_fetched_at,
                           loaded_at = now()""",
                    [(dataset, d, len(f), fetched) for (d, fetched), f in zip(days, frames)])
        log.info("%s: %d: loaded %d days, %d rows", table, year, len(days), len(df))
    return len(todo)


def trading_calendar(manifest: pd.DataFrame) -> pd.DataFrame:
    """Trading if any dataset has the day; holiday if confirmed absent. Pending/missing days are left out."""
    m = manifest.assign(trade_date=manifest["trade_date"].dt.date)
    trading = set(m.loc[m["status"] == "ok", "trade_date"])
    holiday = set(m.loc[m["status"] == "holiday", "trade_date"]) - trading
    days = sorted(trading | holiday)
    return pd.DataFrame({"trade_date": days, "is_trading": [d in trading for d in days]})


def replace_table(conn: psycopg.Connection, table: str, df: pd.DataFrame) -> None:
    with conn.transaction():
        conn.execute(sql.SQL("delete from {}").format(sql.Identifier(table)))
        if not df.empty:
            copy_frame(conn, table, df)
    log.info("%s: replaced, %d rows", table, len(df))


def load_all(s: PgSettings, datasets=ALL_DATASETS, reload: bool = False) -> dict[str, int]:
    """Full loader run: per-day datasets (downloaded, then Greeks), then calendar and derived tables."""
    manifest = Manifest().frame()
    with tunnel(s), connect(s) as conn:
        require_schema(conn)
        result = {}
        for ds in datasets:
            result[TABLES[ds]] = load_dataset(
                conn, ds, TABLES[ds], manifest_versions(manifest, ds),
                lambda d, ds=ds: pd.read_parquet(store.day_path(ds, d)), reload)
        result[GREEKS_TABLE] = load_dataset(
            conn, GREEKS_TABLE, GREEKS_TABLE, file_versions(greeks.greeks_dir()),
            lambda d: pd.read_parquet(greeks.greeks_path(d)), reload)
        replace_table(conn, "trading_calendar", trading_calendar(manifest))
        for table, name in DERIVED.items():
            df = analytics.load_derived(name)
            replace_table(conn, table, df)
            result[table] = len(df)
    return result


def status(s: PgSettings) -> pd.DataFrame:
    with tunnel(s), connect(s) as conn:
        require_schema(conn)
        cur = conn.execute(
            """select dataset, count(*) as days, sum(rows) as rows, min(trade_date) as first_day,
                      max(trade_date) as last_day, max(loaded_at) as last_loaded_at
               from load_log group by dataset order by dataset""")
        return pd.DataFrame(cur.fetchall(), columns=[c.name for c in cur.description])
