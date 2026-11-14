"""Daily global market series from FRED (St. Louis Fed): world markets, crude oil and the rupee.

FRED republishes official and licensed data, free and with no API key:
- brent     DCOILBRENTEU  Europe Brent spot, USD/barrel, from 1987. India's crude benchmark.
- wti       DCOILWTICO    WTI Cushing spot, USD/barrel, from 1986. It was negative on 2020-04-20; that is real.
- usdinr    DEXINUS       Rupees per US dollar (Fed H.10 noon New York rate), from 1973. Up = weaker rupee.
- sp500     SP500         S&P 500 close. FRED keeps only the last 10 years (licence), so history
                          older than that exists only in our store; see `fetch`.
- nasdaq    NASDAQCOM     Nasdaq Composite close, from 1971.
- us_vix    VIXCLS        CBOE VIX (US fear gauge) close, from 1990.
- us_10y    DGS10         US 10-year Treasury yield, % a year, from 1962.
- usd_index DTWEXBGS      Fed broad US dollar index, from 2006 (published weekly, a week late).
- nikkei    NIKKEI225     Nikkei 225 close, from 1949.

Timing (the easy thing to get wrong): US and London values dated D are set after NSE closes on D,
so they can only explain Nifty from the next session; `align_to_sessions` enforces this.
The Nikkei closes at 11:30 IST, during NSE's session on D; the same strict alignment uses it
only from D+1, which is safe but leaves its same-day information for intraday models.
FRED also posts with a lag (a day for markets, days for crude, about a week for the rupee and
the dollar index), so this suits research, not live trading.

Each run downloads every series in full and merges it into the store: downloaded values replace
stored ones (sources revise), and stored dates the source no longer serves are kept (the S&P 500
window moves forward a day at a time). Stored as data/curated/fred/macro_daily.parquet, long format.
"""

import io
import logging
from datetime import date
from pathlib import Path

import pandas as pd

from . import config

log = logging.getLogger(__name__)

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"
# series name -> (FRED id, unit)
SERIES = {
    "brent": ("DCOILBRENTEU", "usd_per_barrel"),
    "wti": ("DCOILWTICO", "usd_per_barrel"),
    "usdinr": ("DEXINUS", "inr_per_usd"),
    "sp500": ("SP500", "index_points"),
    "nasdaq": ("NASDAQCOM", "index_points"),
    "us_vix": ("VIXCLS", "index_points"),
    "us_10y": ("DGS10", "percent_a_year"),
    "usd_index": ("DTWEXBGS", "index_points"),
    "nikkei": ("NIKKEI225", "index_points"),
}
COLUMNS = ["obs_date", "series", "value", "unit", "fred_id"]
MUST_BE_POSITIVE = ("brent", "usdinr", "sp500", "nasdaq", "us_vix", "usd_index", "nikkei")


def path(root: Path | None = None) -> Path:
    return (root or config.CURATED_DIR) / "fred" / "macro_daily.parquet"


def parse_fred_csv(raw: bytes, series: str) -> pd.DataFrame:
    """FRED CSV (observation_date,<ID>) -> tidy rows. Blank or '.' values are non-trading days and dropped."""
    fred_id, unit = SERIES[series]
    df = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
    if list(df.columns) != ["observation_date", fred_id]:
        raise ValueError(f"unexpected FRED columns for {fred_id}: {list(df.columns)}")
    df = df[~df[fred_id].str.strip().isin(["", "."])]
    out = pd.DataFrame({
        "obs_date": pd.to_datetime(df["observation_date"], format="%Y-%m-%d").dt.date,
        "series": series,
        "value": pd.to_numeric(df[fred_id], errors="raise").astype("float64"),
        "unit": unit,
        "fred_id": fred_id,
    })
    if out["obs_date"].duplicated().any():
        raise ValueError(f"duplicate dates in FRED {fred_id}")
    return out.sort_values("obs_date").reset_index(drop=True)


def _default_client():
    from .nse.http import ArchiveClient  # polite retrying client; nothing in it is NSE-specific
    client = ArchiveClient(min_interval=1.0, retries=2, timeout=60)
    # FRED resets connections that claim to be a browser (tested 2026-11-07); be honest.
    client.session.headers["User-Agent"] = "niftyquant/0.1 (python-requests)"
    return client


def merge(new: pd.DataFrame, old: pd.DataFrame) -> pd.DataFrame:
    """New values win; stored dates missing from the new download are kept; series no longer
    configured are dropped."""
    if old.empty:
        return new
    old = old[old["series"].isin(list(SERIES))]
    have = pd.MultiIndex.from_frame(new[["series", "obs_date"]])
    keep = old[~pd.MultiIndex.from_frame(old[["series", "obs_date"]]).isin(have)]
    out = pd.concat([new, keep[COLUMNS]], ignore_index=True)
    return out.sort_values(["series", "obs_date"]).reset_index(drop=True)


def fetch(client=None, root: Path | None = None) -> pd.DataFrame:
    """Download every series and merge it into the stored file (all or nothing: if any series fails,
    nothing is written). Returns a per-series summary."""
    client = client or _default_client()
    frames = []
    for series, (fred_id, _) in SERIES.items():
        url = FRED_CSV.format(fred_id)
        raw = client.get(url)
        if raw is None:
            raise RuntimeError(f"FRED returned nothing for {fred_id} ({url})")
        frames.append(parse_fred_csv(raw, series))
    df = merge(pd.concat(frames, ignore_index=True)[COLUMNS], read(root))
    out = path(root)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False, compression="zstd")
    tmp.replace(out)
    log.info("macro: %d rows written to %s", len(df), out)
    return summary(df)


def read(root: Path | None = None) -> pd.DataFrame:
    p = path(root)
    return pd.read_parquet(p) if p.is_file() else pd.DataFrame(columns=COLUMNS)


def summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    df = df.sort_values("obs_date")
    s = df.groupby("series").agg(unit=("unit", "first"), first=("obs_date", "min"),
                                 last=("obs_date", "max"), rows=("obs_date", "size"))
    s["last_value"] = df.groupby("series")["value"].last()
    return s


def align_to_sessions(df: pd.DataFrame, sessions, series: str) -> pd.DataFrame:
    """For each NSE session date, the latest value dated strictly before it (no look-ahead).

    Returns trade_date, source_date, value and ret_pct, the % change between the last two
    values known at that session's open.
    """
    px = df[df["series"] == series][["obs_date", "value"]].sort_values("obs_date")
    px = px.assign(ret_pct=px["value"].pct_change() * 100,
                   source_date=pd.to_datetime(px["obs_date"]))
    s = pd.DataFrame({"trade_date": pd.to_datetime(pd.Series(sessions)).sort_values().unique()})
    out = pd.merge_asof(s, px[["source_date", "value", "ret_pct"]], left_on="trade_date",
                        right_on="source_date", allow_exact_matches=False, direction="backward")
    out["trade_date"] = out["trade_date"].dt.date
    out["source_date"] = out["source_date"].dt.date
    return out


def check(df: pd.DataFrame, today: date | None = None, max_stale_days: int = 14) -> dict[str, pd.DataFrame]:
    """Quality checks; an empty frame means pass."""
    if df.empty:
        return {"macro_missing": pd.DataFrame({"message": ["no FRED data; run `niftyquant macro`"]})}
    today = today or date.today()
    s = summary(df).reset_index()
    return {
        "macro_series_absent": pd.DataFrame({"series": sorted(set(SERIES) - set(s["series"]))}),
        "macro_duplicates": df[df.duplicated(["series", "obs_date"], keep=False)],
        "macro_stale_series": s[s["last"].map(lambda d: (today - d).days > max_stale_days)],
        "macro_non_positive": df[df["series"].isin(MUST_BE_POSITIVE) & (df["value"] <= 0)],
    }
