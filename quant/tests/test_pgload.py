"""Loader logic that needs no database: settings, what to send, calendar, CSV encoding."""

import io
import re
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from niftyquant import pgload


def manifest(*rows):
    return pd.DataFrame(rows, columns=["dataset", "trade_date", "status", "fetched_at"]).assign(
        trade_date=lambda m: pd.to_datetime(m["trade_date"]))


def test_settings_from_env(monkeypatch):
    for k in ("PG_DB", "PG_USER"):
        monkeypatch.delenv(k, raising=False)
    assert pgload.PgSettings.from_env() is None
    monkeypatch.setenv("PG_DB", "niftyquant")
    monkeypatch.setenv("PG_USER", "develop")
    monkeypatch.setenv("PG_SSH_HOST", "ubuntu@example.com")
    monkeypatch.setenv("PG_LOCAL_PORT", "15999")
    s = pgload.PgSettings.from_env()
    assert s.endpoint == ("127.0.0.1", 15999)
    monkeypatch.setenv("PG_SSH_HOST", "")
    assert pgload.PgSettings.from_env().endpoint == ("localhost", 5432)


def test_pending_days_sends_new_and_refetched_only():
    t1, t2 = "2026-11-05T14:00:00+00:00", "2026-11-07T07:00:00+00:00"
    m = manifest(("fo_bhavcopy", "2026-11-05", "ok", t1),
                 ("fo_bhavcopy", "2026-11-06", "ok", t2),
                 ("fo_bhavcopy", "2026-11-04", "ok", t1),
                 ("fo_bhavcopy", "2026-11-07", "pending", t2),
                 ("index_close", "2026-11-05", "ok", t1))
    loaded = {date(2026, 11, 5): datetime(2026, 11, 5, 14, tzinfo=timezone.utc),  # unchanged
              date(2026, 11, 4): datetime(2026, 11, 4, 14, tzinfo=timezone.utc)}  # re-fetched since
    got = pgload.pending_days(pgload.manifest_versions(m, "fo_bhavcopy"), loaded)
    assert [d for d, _ in got] == [date(2026, 11, 4), date(2026, 11, 6)]


def test_file_versions_follow_mtime(tmp_path):
    p = tmp_path / "year=2026" / "2026-11-06.parquet"
    p.parent.mkdir()
    p.write_bytes(b"x")
    v = pgload.file_versions(tmp_path)
    assert list(v) == [date(2026, 11, 6)] and v[date(2026, 11, 6)].tzinfo is not None
    assert pgload.pending_days(v, {date(2026, 11, 6): v[date(2026, 11, 6)]}) == []


def test_trading_calendar():
    t = "2026-11-07T07:00:00+00:00"
    m = manifest(("index_close", "2026-11-06", "ok", t),
                 ("index_close", "2026-11-08", "holiday", t),
                 ("index_close", "2026-11-09", "missing", t),     # index file absent ...
                 ("fo_bhavcopy", "2026-11-09", "ok", t),          # ... but F&O traded: trading day
                 ("index_close", "2026-11-10", "pending", t))     # not decided yet: left out
    cal = pgload.trading_calendar(m)
    assert cal.to_dict("list") == {
        "trade_date": [date(2026, 11, 6), date(2026, 11, 8), date(2026, 11, 9)],
        "is_trading": [True, False, True]}


def test_copy_csv_encodes_missing_as_null():
    df = pd.DataFrame({"strike": [np.nan, 25000.0], "option_type": pd.array([None, "CE"], dtype="string"),
                       "lot_size": pd.array([65, None], dtype="Int64"), "close": [25032.4, 0.1 + 0.2]})
    buf = io.StringIO()
    df.to_csv(buf, index=False, header=False, lineterminator="\n")
    lines = buf.getvalue().splitlines()
    assert lines[0] == ",,65,25032.4"          # empty unquoted field = NULL in COPY csv
    assert lines[1] == "25000.0,CE,,0.30000000000000004"  # full float precision round-trips


MIGRATIONS = Path(__file__).resolve().parents[2] / "backend" / "src" / "main" / "resources" / "db" / "migration"


def _created_tables() -> dict[str, str]:
    """Table name -> body of its `create table` statement, across all Flyway migrations."""
    out = {}
    for f in sorted(MIGRATIONS.glob("V*__*.sql")):
        for m in re.finditer(r"create table (\w+) \((.*?)\);", f.read_text(encoding="utf-8"), re.S):
            out[m.group(1)] = m.group(2)
    return out


def test_every_loaded_table_has_a_migration():
    created = _created_tables()
    wanted = [*pgload.TABLES.values(), pgload.GREEKS_TABLE, *pgload.DERIVED, "trading_calendar", "load_log"]
    assert [t for t in wanted if t not in created] == []


def test_stock_tables_match_parquet_columns():
    from niftyquant.nse import parsers
    body = _created_tables()["stock_eod"]
    cols = [line.split()[0] for line in body.splitlines()
            if line.strip() and not line.strip().startswith("primary key")]
    assert cols == parsers.CM_COLUMNS
    # stock_fo_eod is `like fo_eod`, so the stock F&O frame must have fo_eod's columns.
    assert "like fo_eod including all" in _created_tables()["stock_fo_eod"]


def test_cli_pg_datasets_match_loader():
    from niftyquant import cli
    assert set(cli.PG_DATASETS) == set(pgload.PG_DATASETS)
