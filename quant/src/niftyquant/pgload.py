"""Copy the curated Parquet store into Postgres.

The schema belongs to the backend (Flyway migrations in backend/src/main/resources/db/migration);
this module only writes rows. Each run sends days that are new or were re-fetched since the last
load (tracked in load_log), then replaces the small derived tables and the trading calendar.

Postgres listens only on the server's localhost, so connections go through an SSH port-forward.
Each run opens its own on a free local port for its duration (see tunnel); the long-lived
local_port tunnel from dev.ps1 is the backend's. One run at a time: see acquire_lock.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from itertools import groupby
from pathlib import Path

import pandas as pd
import psycopg
from psycopg import sql

from . import analytics, config, events, greeks, nifty_weights, premiums, results, stockiv, stocks, store
from .store import Manifest

log = logging.getLogger(__name__)

# Per-day downloaded datasets -> table. Stock datasets come from `niftyquant stocks`, the rest from ingest.
TABLES = {
    "fo_bhavcopy": "fo_eod",
    "index_close": "index_eod",
    "participant_oi": "participant_oi",
    "participant_vol": "participant_vol",
    stocks.CM: "stock_eod",
    stocks.FO_STOCK: "stock_fo_eod",
}
PG_DATASETS = tuple(TABLES)
GREEKS_TABLE = "option_greeks"  # per-day derived files, versioned by file time
DERIVED = {"daily_market": analytics.DAILY_MARKET, "participants_daily": analytics.PARTICIPANTS,
           "iv_daily": analytics.IV_DAILY, "moneyness_daily": premiums.FILE,
           "market_events": events.FILE, "event_impact": events.IMPACT_FILE,
           "stock_iv": stockiv.FILE, "nifty_weights": nifty_weights.FILE,
           "nifty_weight_fits": nifty_weights.FIT_FILE, "result_events": results.FILE,
           "result_summary": results.SUMMARY_FILE}
COPY_CHUNK = 200_000
# Postgres advisory-lock key held for a whole load run. A second run (the nightly update while a
# long manual load is still going) would delete and re-insert the same months underneath the first.
LOCK_KEY = 0x6E716C64  # "nqld"


class LoadBusy(RuntimeError):
    """Another pg-load run holds the loader lock."""


def acquire_lock(conn: psycopg.Connection) -> None:
    """Take the session-level loader lock, or raise LoadBusy. Postgres releases it when the
    connection closes, so a crashed or killed run never leaves it stuck."""
    if not conn.execute("select pg_try_advisory_lock(%s)", (LOCK_KEY,)).fetchone()[0]:
        raise LoadBusy("another pg-load is running (it will send these days too, or the next run will)")


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


def _free_port() -> int:
    with socket.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        return sk.getsockname()[1]


@contextmanager
def tunnel(s: PgSettings, timeout: float = 20.0):
    """A private SSH port-forward for this run, on a free local port; yields the settings to
    connect with. Loads do not share the long-lived local_port tunnel (the backend's, from
    dev.ps1): under hours of COPY traffic that one went stale while a fresh tunnel worked. ssh's
    stderr goes to a log file, not a pipe nobody reads, which would stall ssh once full."""
    if not s.ssh_host:
        yield s
        return
    port = _free_port()
    cmd = ["ssh", "-N", "-C", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
           "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
           "-L", f"{port}:{s.host}:{s.port}", s.ssh_host]
    log_path = config.DATA_DIR / "logs" / "pg_tunnel.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "ab") as err:
        err.write(f"--- {datetime.now():%Y-%m-%d %H:%M:%S} port {port}{os.linesep}".encode())
        err.flush()
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err)
    try:
        deadline = time.monotonic() + timeout
        while not _listening(port):
            if proc.poll() is not None:
                tail = log_path.read_text(errors="replace").strip().splitlines()[-3:]
                raise RuntimeError(f"SSH tunnel to {s.ssh_host} failed: {' / '.join(tail)}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"SSH tunnel to {s.ssh_host} did not open within {timeout:.0f}s")
            time.sleep(0.2)
        log.info("SSH tunnel open: 127.0.0.1:%d -> %s:%d via %s", port, s.host, s.port, s.ssh_host)
        yield replace(s, local_port=port)
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
    """Send pending days for one dataset, one transaction per month (a dropped connection loses at
    most that month, which the next run re-sends). Returns days loaded."""
    loaded = {} if reload else dict(conn.execute(
        "select trade_date, source_fetched_at from load_log where dataset = %s", (dataset,)).fetchall())
    todo = pending_days(versions, loaded)
    for month, group in groupby(todo, key=lambda x: x[0].strftime("%Y-%m")):
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
        log.info("%s: %s: loaded %d days, %d rows", table, month, len(days), len(df))
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


def load_all(s: PgSettings, datasets=PG_DATASETS, reload: bool = False) -> dict[str, int]:
    """Full loader run: per-day datasets (downloaded, then Greeks), then calendar and derived tables."""
    manifest = Manifest().frame()
    with tunnel(s) as t, connect(t) as conn:
        require_schema(conn)
        acquire_lock(conn)
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
    with tunnel(s) as t, connect(t) as conn:
        require_schema(conn)
        cur = conn.execute(
            """select dataset, count(*) as days, sum(rows) as rows, min(trade_date) as first_day,
                      max(trade_date) as last_day, max(loaded_at) as last_loaded_at
               from load_log group by dataset order by dataset""")
        return pd.DataFrame(cur.fetchall(), columns=[c.name for c in cur.description])
