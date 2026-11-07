"""Stock-level end-of-day data for result and event studies.

Two datasets, both from NSE's public archive (nsearchives.nseindia.com), one file per trading day:
- cm_bhavcopy: cash-market close for every NSE equity (series EQ and BE). NSE's prev_close is
  adjusted for corporate actions on the ex-date, so close / prev_close - 1 is a clean daily return
  even across bonuses and splits (Reliance 1:1 in 2017 and 2024, HDFC Bank 1:1 in 2025).
- fo_stock: stock futures and options for UNIVERSE only, taken from the same F&O bhavcopy as the
  Nifty data (the Nifty pipeline keeps index contracts only). Same columns as fo_bhavcopy.

Days are the F&O sessions already in the store (so holidays are never requested), from START.
Fetch status is kept in the shared manifest, so failed days are retried on the next run.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

import pandas as pd

from . import config
from .nse import parsers, sources
from .store import FINAL, Manifest, day_path, read_dataset, write_day

log = logging.getLogger(__name__)

CM = "cm_bhavcopy"
FO_STOCK = "fo_stock"
DATASETS = (CM, FO_STOCK)
START = date(2018, 1, 1)
PENDING_DAYS = 3

# Nifty 50 heavyweights (roughly the top 15 by weight in 2024-2026, about 60% of the index together),
# plus HDFC Ltd, a top-3 weight until it merged into HDFC Bank (last traded 2023-07-12).
UNIVERSE = ("HDFCBANK", "ICICIBANK", "RELIANCE", "INFY", "BHARTIARTL", "TCS", "LT", "ITC", "KOTAKBANK",
            "AXISBANK", "SBIN", "HINDUNILVR", "BAJFINANCE", "M&M", "HDFC")


def sessions(start: date = START, end: date | None = None) -> list[date]:
    """Trading sessions we hold Nifty F&O files for."""
    files = (config.CURATED_DIR / "nse" / "fo_bhavcopy").glob("year=*/*.parquet")
    days = sorted(date.fromisoformat(p.stem) for p in files)
    return [d for d in days if d >= start and (end is None or d <= end)]


def _fetch_cm(client, d: date) -> tuple[pd.DataFrame | None, str]:
    for fmt, url in sources.cm_bhavcopy_candidates(d):
        raw = client.get(url)
        if raw is not None:
            parse = parsers.parse_cm_udiff if fmt == "udiff" else parsers.parse_cm_legacy
            return parse(raw, d), url
    return None, sources.cm_bhavcopy_candidates(d)[0][1]


def _fetch_fo_stock(client, d: date) -> tuple[pd.DataFrame | None, str]:
    for fmt, url in sources.fo_bhavcopy_candidates(d):
        raw = client.get(url)
        if raw is not None:
            parse = parsers.parse_fo_udiff if fmt == "udiff" else parsers.parse_fo_legacy
            return parse(raw, d, UNIVERSE, kind="stock"), url
    return None, sources.fo_bhavcopy_candidates(d)[0][1]


FETCHERS = {CM: _fetch_cm, FO_STOCK: _fetch_fo_stock}


def fetch(datasets=DATASETS, start: date = START, end: date | None = None, force: bool = False,
          client=None, manifest: Manifest | None = None, today: date | None = None) -> pd.DataFrame:
    """Download missing days. Returns one row per (dataset, day) attempted, with its result."""
    if client is None:
        from .nse.http import ArchiveClient
        client = ArchiveClient()
    manifest = manifest or Manifest()
    today = today or date.today()
    done = manifest.frame()
    results = []
    for ds in datasets:
        final = set()
        if not force and not done.empty:
            m = done[(done["dataset"] == ds) & done["status"].isin(FINAL)]
            final = set(m["trade_date"].dt.date)
        todo = [d for d in sessions(start, end) if d not in final]
        log.info("%s: %d sessions to fetch", ds, len(todo))
        for i, d in enumerate(todo, 1):
            try:
                df, url = FETCHERS[ds](client, d)
                if df is None:
                    status = "pending" if (today - d) <= timedelta(days=PENDING_DAYS) else "missing"
                    manifest.record(ds, d, status, url=url, message="not in NSE archive")
                else:
                    write_day(df, ds, d)
                    status = "ok"
                    manifest.record(ds, d, status, rows=len(df), url=url)
            except Exception as e:  # keep going; the day is retried next run
                status = "error"
                manifest.record(ds, d, status, message=str(e)[:500])
                log.warning("%s %s: %s", ds, d, e)
            results.append({"dataset": ds, "trade_date": d, "result": status})
            if i % 100 == 0:
                log.info("%s: progress %d/%d (at %s)", ds, i, len(todo), d)
    return pd.DataFrame(results)


def read_cm(start: date | None = None, end: date | None = None, symbols=None) -> pd.DataFrame:
    df = read_dataset(CM, start, end)
    if symbols is not None and not df.empty:
        df = df[df["symbol"].isin(symbols)]
    return df


def read_fo_stock(start: date | None = None, end: date | None = None) -> pd.DataFrame:
    return read_dataset(FO_STOCK, start, end)


def has_day(dataset: str, d: date) -> bool:
    return day_path(dataset, d).exists()
