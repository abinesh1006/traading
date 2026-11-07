"""Stock-level end-of-day data for result and event studies.

Two datasets, both from NSE's public archive (nsearchives.nseindia.com), one file per trading day:
- cm_bhavcopy: cash-market close for every NSE equity (series EQ and BE). NSE's prev_close is the
  previous session's close as traded: it is NOT adjusted on split or bonus ex-dates (HDFC Bank's
  1:1 bonus shows as 1964.10 -> 973.40 on 2025-08-26), though it is on demergers, where NSE
  discovers the ex-price in a special session (Reliance / Jio Financial, 2023-07-20). Use
  adjust() before computing returns.
- fo_stock: stock futures and options for UNIVERSE only, taken from the same F&O bhavcopy as the
  Nifty data (the Nifty pipeline keeps index contracts only). Same columns as fo_bhavcopy.

Days are the trading sessions already in the store (index-close files, so holidays are never
requested), from START. Fetch status is kept in the shared manifest, so failed days are retried
on the next run.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
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
    """Trading sessions in the store: days with an index-close or Nifty F&O file. (NSE's archive
    lacks the F&O file for 2021-03-30, a trading day; the index-close file exists.)"""
    days = set()
    for ds in ("index_close", "fo_bhavcopy"):
        days |= {date.fromisoformat(p.stem) for p in (config.CURATED_DIR / "nse" / ds).glob("year=*/*.parquet")}
    return sorted(d for d in days if d >= start and (end is None or d <= end))


# Price ratios of splits and bonuses: 1:1 bonus or a 2-for-1 split = 1/2, 1:2 bonus = 2/3, a face
# value cut from 10 to 1 = 1/10; consolidations the other way.
SPLIT_RATIOS = (1 / 2, 1 / 3, 2 / 3, 1 / 4, 1 / 5, 1 / 10, 2, 3, 4, 5, 10)
SPLIT_MOVE = (0.7, 1.6)      # market-adjusted close / prev_close outside this range is examined
SPLIT_TOLERANCE = 0.12       # the move left after taking out the ratio must be under 12%


def adjust(cm: pd.DataFrame, market_return_pct: pd.Series) -> pd.DataFrame:
    """Add ca_factor (the split/bonus price ratio on its ex-date, else 1) and adj_prev_close
    (prev_close x ca_factor), so close / adj_prev_close - 1 is the day's real return.

    A split is found where the move, after taking out the market's move that day, is too big to be
    a trading move but matches a standard ratio: the 2020-03-23 crash (Axis Bank -28% with Nifty
    -13%) is not a split; HDFC Bank -50% on 2025-08-26 with Nifty flat is. A real -30% crash in a
    quiet market that happens to sit near 2/3 would be misread; none occurs in UNIVERSE since 2018."""
    out = cm.copy()
    m = 1 + out["trade_date"].map(market_return_pct).fillna(0.0) / 100
    rr = (out["close"] / out["prev_close"]) / m
    factor = np.ones(len(out))
    cand = ((rr < SPLIT_MOVE[0]) | (rr > SPLIT_MOVE[1])).to_numpy() & np.isfinite(rr.to_numpy())
    if cand.any():
        ratios = np.array(SPLIT_RATIOS)
        x = rr.to_numpy()[cand][:, None]
        best = ratios[np.argmin(np.abs(np.log(x / ratios)), axis=1)]
        ok = np.abs(x[:, 0] / best - 1) < SPLIT_TOLERANCE
        factor[np.flatnonzero(cand)[ok]] = best[ok]
    out["ca_factor"] = factor
    out["adj_prev_close"] = out["prev_close"] * factor
    return out


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
