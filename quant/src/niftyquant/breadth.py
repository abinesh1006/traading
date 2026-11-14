"""Daily NSE market breadth and activity, from the "Market Activity" report (MAddmmyy.csv).

Per trading day, all NSE equities (not only Nifty 50):
- advances, declines, unchanged: number of stocks that closed up, down, flat
- price_band_hits: stocks that hit their daily price band (circuit limit)
- traded_value_cr, traded_qty_lakh, trades, market_cap_cr: cash-market activity

Archive: https://nsearchives.nseindia.com/archives/equities/mkt/MAddmmyy.csv, from 2015 and earlier,
published the evening of each session (so usable from the next session).
Only trading days are fetched: days with an `index_close` file in our store. Missing days are
retried on every run. Stored as data/curated/nse/market_breadth/year=YYYY/YYYY-MM-DD.parquet.
"""

import logging
import re
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from . import config
from .store import day_path, read_dataset, write_day

log = logging.getLogger(__name__)

DATASET = "market_breadth"
ARCHIVE = "https://nsearchives.nseindia.com/archives/equities/mkt/MA{:%d%m%y}.csv"
PENDING_DAYS = 3

FIELDS = {  # label in the file (lower case, prefix) -> column
    "traded value (rs. in crores)": "traded_value_cr",
    "traded quantity (in lakhs)": "traded_qty_lakh",
    "number of trades": "trades",
    "total market capitalisation (rs. crores)": "market_cap_cr",
    "advances": "advances",
    "declines": "declines",
    "unchanged": "unchanged",
    "total securities that have hit their price bands today": "price_band_hits",
}
COLUMNS = ["trade_date", "advances", "declines", "unchanged", "price_band_hits",
           "traded_value_cr", "traded_qty_lakh", "trades", "market_cap_cr"]
INTS = ["advances", "declines", "unchanged", "price_band_hits", "trades"]


class ParseError(ValueError):
    pass


def url(d: date) -> str:
    return ARCHIVE.format(d)


def parse(raw: bytes, requested: date) -> pd.DataFrame:
    lines = [ln.strip().strip(",").strip() for ln in raw.decode("utf-8-sig", errors="replace").splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        raise ParseError("empty market activity file")
    try:
        file_date = datetime.strptime(lines[0], "%d-%b-%Y").date()
    except ValueError as e:
        raise ParseError(f"first line is not a date: {lines[0][:40]!r}") from e
    if file_date != requested:
        raise ParseError(f"file is for {file_date}, requested {requested}")
    row: dict = {"trade_date": requested}
    for ln in lines[1:]:
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) != 2:
            continue
        label, value = parts[0].lower(), parts[1]
        col = FIELDS.get(label)
        if col is None or col in row:
            continue
        try:
            row[col] = float(value.replace(",", ""))
        except ValueError as e:
            raise ParseError(f"{label}: not a number: {value!r}") from e
        if len(row) == len(FIELDS) + 1:
            break
    missing = [c for c in FIELDS.values() if c not in row]
    if missing:
        raise ParseError(f"fields not found: {missing}")
    df = pd.DataFrame([row])[COLUMNS]
    for c in INTS:
        if not (df[c] == df[c].round()).all():
            raise ParseError(f"{c} is not a whole number")
        df[c] = df[c].astype("int64")
    if (df[["advances", "declines", "unchanged"]].sum(axis=1) <= 0).any():
        raise ParseError("no stocks counted")
    return df


def trading_days(root: Path | None = None) -> list[date]:
    """Our trading calendar: days with an NSE all-indices close file."""
    base = (root or config.CURATED_DIR) / "nse" / "index_close"
    return sorted(date.fromisoformat(p.stem) for p in base.glob("year=*/*.parquet"))


def fetch(start: date | None = None, end: date | None = None, client=None, root: Path | None = None,
          today: date | None = None, force: bool = False) -> pd.DataFrame:
    """Download trading days that have no breadth file yet. Returns a log frame (one row per day tried)."""
    if client is None:
        from .nse.http import ArchiveClient
        client = ArchiveClient()
    today = today or date.today()
    days = [d for d in trading_days(root) if (start is None or d >= start) and (end is None or d <= end)]
    rows = []
    for d in days:
        if not force and day_path(DATASET, d, root).exists():
            continue
        try:
            raw = client.get(url(d))
            if raw is None:
                result = "pending" if (today - d).days < PENDING_DAYS else "missing"
            else:
                write_day(parse(raw, d), DATASET, d, root)
                result = "ok"
        except Exception as e:  # logged, retried next run
            log.error("market breadth %s failed: %s", d, e)
            result = "error"
        rows.append({"trade_date": d, "result": result})
        if len(rows) % 100 == 0:
            log.info("market breadth: %d days tried (at %s)", len(rows), d)
    return pd.DataFrame(rows, columns=["trade_date", "result"])


def read(start: date | None = None, end: date | None = None, root: Path | None = None) -> pd.DataFrame:
    return read_dataset(DATASET, start, end, root)


def check(df: pd.DataFrame, sessions=None, today: date | None = None) -> dict[str, pd.DataFrame]:
    """Trading days (older than PENDING_DAYS) without a breadth file."""
    if sessions is None:
        return {"breadth_missing_days": pd.DataFrame()}
    today = today or date.today()
    have = set(df["trade_date"]) if not df.empty else set()
    want = sorted(d for d in set(pd.to_datetime(pd.Series(sessions)).dt.date)
                  if d not in have and (today - d).days >= PENDING_DAYS)
    return {"breadth_missing_days": pd.DataFrame({"trade_date": want})}
