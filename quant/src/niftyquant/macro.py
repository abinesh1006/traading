"""Daily global market series from FRED (St. Louis Fed): crude oil and the rupee.

FRED republishes official US data, free and with no API key:
- brent  DCOILBRENTEU  Europe Brent spot, USD/barrel, from 1987. India's crude benchmark.
- wti    DCOILWTICO    WTI Cushing spot, USD/barrel, from 1986. It was negative on 2020-04-20; that is real.
- usdinr DEXINUS       Rupees per US dollar (Fed H.10 noon New York rate), from 1973. Up = weaker rupee.

Timing (the easy thing to get wrong): each value dated D is set after NSE closes on D
(London/New York close for crude, New York noon for the rupee). It is unknown during Nifty's
session on D and can only explain Nifty from the next session onwards. Use `align_to_sessions`,
which enforces this. FRED also posts with a lag (crude a few days, rupee up to about a week),
so this suits research, not live trading.

The whole history is re-downloaded on every run, because sources revise past values and the
files are small. Stored as data/curated/fred/macro_daily.parquet in long format.
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
}
COLUMNS = ["obs_date", "series", "value", "unit", "fred_id"]
MUST_BE_POSITIVE = ("brent", "usdinr")


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


def fetch(client=None, root: Path | None = None) -> pd.DataFrame:
    """Download every series and replace the stored file (all or nothing). Returns a per-series summary."""
    client = client or _default_client()
    frames = []
    for series, (fred_id, _) in SERIES.items():
        url = FRED_CSV.format(fred_id)
        raw = client.get(url)
        if raw is None:
            raise RuntimeError(f"FRED returned nothing for {fred_id} ({url})")
        frames.append(parse_fred_csv(raw, series))
    df = pd.concat(frames, ignore_index=True)[COLUMNS]
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
