"""NSE provisional FII/FPI and DII cash-market flows, recorded daily from now on.

NSE publishes these on the evening of each session (from stock-exchange trade data, so they are
same-day, unlike NSDL's custodian-confirmed figures, which lag a session). The API only ever
returns the latest day and NSE keeps no history, so the daily `update` job saves one file per
day. Missed evenings cannot be recovered later.

Stored as data/curated/nse/fii_dii_provisional/year=YYYY/YYYY-MM-DD.parquet with one row per
category (FII, DII). Amounts are Rs crore.
"""

import json
import logging
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from . import config
from .store import day_path, read_dataset, write_day

log = logging.getLogger(__name__)

DATASET = "fii_dii_provisional"
API = "https://www.nseindia.com/api/fiidiiTradeReact"
REFERER = "https://www.nseindia.com/reports/fii-dii"
CATEGORIES = {"FII/FPI": "FII", "DII": "DII"}
COLUMNS = ["trade_date", "category", "buy_cr", "sell_cr", "net_cr"]


class ParseError(ValueError):
    pass


def parse(raw: bytes | str) -> pd.DataFrame:
    items = json.loads(raw)
    if not isinstance(items, list):
        raise ParseError(f"expected a list, got {type(items).__name__}")
    rows = []
    for it in items:
        cat = CATEGORIES.get(str(it.get("category", "")).strip())
        if cat is None:
            raise ParseError(f"unknown category {it.get('category')!r}")
        buy, sell, net = (float(str(it[k]).replace(",", "")) for k in ("buyValue", "sellValue", "netValue"))
        if abs(buy - sell - net) > 0.05:
            raise ParseError(f"{cat}: buy - sell != net ({buy} - {sell} != {net})")
        rows.append({"trade_date": datetime.strptime(it["date"], "%d-%b-%Y").date(),
                     "category": cat, "buy_cr": buy, "sell_cr": sell, "net_cr": net})
    df = pd.DataFrame(rows, columns=COLUMNS)
    if sorted(df["category"]) != ["DII", "FII"]:
        raise ParseError(f"expected one FII and one DII row, got {df['category'].tolist()}")
    if df["trade_date"].nunique() != 1:
        raise ParseError(f"rows for several dates: {sorted(df['trade_date'].unique())}")
    return df.sort_values("category").reset_index(drop=True)


def _session():
    import requests
    from .nse.http import BROWSER_UA
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*",
                      "Accept-Language": "en-US,en;q=0.9", "Referer": REFERER})
    return s


def fetch(get=None, root: Path | None = None) -> pd.DataFrame:
    """Save whatever day NSE is currently serving. `get(url) -> bytes` is injectable for tests."""
    if get is None:
        s = _session()

        def get(url):
            r = s.get(url, timeout=30)
            r.raise_for_status()
            return r.content
    df = parse(get(API))
    d = df["trade_date"].iloc[0]
    existed = day_path(DATASET, d, root).exists()
    write_day(df, DATASET, d, root)
    log.info("FII/DII provisional for %s %s", d, "refreshed" if existed else "saved")
    return df


def read(start: date | None = None, end: date | None = None, root: Path | None = None) -> pd.DataFrame:
    return read_dataset(DATASET, start, end, root)


def check(df: pd.DataFrame, sessions=None) -> dict[str, pd.DataFrame]:
    """Sessions since recording began with no saved file (an evening the job did not run)."""
    if df.empty or sessions is None:
        return {"fii_dii_missed_days": pd.DataFrame()}
    first = df["trade_date"].min()
    have = set(df["trade_date"])
    missed = sorted(d for d in set(pd.to_datetime(pd.Series(sessions)).dt.date) if d >= first and d not in have)
    return {"fii_dii_missed_days": pd.DataFrame({"trade_date": missed})}
