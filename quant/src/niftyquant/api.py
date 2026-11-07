"""Research data API consumed by the Spring Boot backend (not exposed to browsers directly).

Run: niftyquant serve  (defaults to http://127.0.0.1:8001)
"""

import json
import math
from datetime import date

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query

from . import analytics, config
from .store import Manifest

app = FastAPI(title="niftyquant research API", version="0.1.0")


def _clean(value):
    """Make pandas/numpy values JSON-safe: NaN -> None, numpy scalars -> Python, dates -> ISO."""
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (np.floating, float)):
        return None if math.isnan(value) else float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (pd.Timestamp, date)):
        return value.isoformat()[:10]
    return value


def _records(df: pd.DataFrame) -> list[dict]:
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


def _between(df: pd.DataFrame, start: date | None, end: date | None) -> pd.DataFrame:
    if df.empty:
        return df
    td = pd.to_datetime(df["trade_date"]).dt.date
    mask = pd.Series(True, index=df.index)
    if start:
        mask &= td >= start
    if end:
        mask &= td <= end
    return df[mask]


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "data_dir": str(config.DATA_DIR)}


@app.get("/market/daily")
def market_daily(start: date | None = None, end: date | None = None) -> list[dict]:
    df = analytics.load_derived(analytics.DAILY_MARKET)
    if df.empty:
        raise HTTPException(503, "derived data not built; run `niftyquant derive`")
    return _records(_between(df, start, end))


@app.get("/market/participants")
def market_participants(start: date | None = None, end: date | None = None) -> list[dict]:
    df = analytics.load_derived(analytics.PARTICIPANTS)
    if df.empty:
        raise HTTPException(503, "derived data not built; run `niftyquant derive`")
    return _records(_between(df, start, end))


@app.get("/market/iv")
def market_iv(start: date | None = None, end: date | None = None) -> list[dict]:
    """Daily volatility summary: ATM IV (near, next, 30-day), 25-delta skew, VIX, realised vol."""
    df = analytics.load_derived(analytics.IV_DAILY)
    if df.empty:
        raise HTTPException(503, "IV not built; run `niftyquant derive`")
    return _records(_between(df, start, end))


@app.get("/market/chain")
def market_chain(trade_date: date = Query(alias="date"), expiry: date | None = None) -> dict:
    try:
        chain = analytics.eod_chain(trade_date, expiry)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if chain is None:
        raise HTTPException(404, f"no F&O data for {trade_date} (holiday or not downloaded)")
    rows = _records(chain.pop("rows"))
    return {k: ([_clean(x) for x in v] if isinstance(v, list) else _clean(v))
            for k, v in chain.items()} | {"rows": rows}


@app.get("/data/status")
def data_status() -> dict:
    m = Manifest().frame()
    if m.empty:
        return {"datasets": [], "last_fetch": None, "quality": None}
    m["year"] = m["trade_date"].dt.year
    counts = (m.groupby(["dataset", "year", "status"]).size()
              .unstack(fill_value=0).reset_index())
    status_cols = [c for c in counts.columns if c not in ("dataset", "year")]
    datasets = []
    for name, g in counts.groupby("dataset"):
        ok_dates = m[(m["dataset"] == name) & (m["status"] == "ok")]["trade_date"]
        datasets.append({
            "dataset": name,
            "first_date": _clean(ok_dates.min()), "last_date": _clean(ok_dates.max()),
            "totals": {c: int(g[c].sum()) for c in status_cols},
            "years": [{"year": int(r["year"]), **{c: int(r[c]) for c in status_cols}}
                      for _, r in g.iterrows()],
        })
    open_items = m[~m["status"].isin(["ok", "holiday"])].sort_values("trade_date")
    return {
        "datasets": datasets,
        "last_fetch": m["fetched_at"].max(),
        "open_items": _records(open_items[["dataset", "trade_date", "status", "message"]].tail(100)),
        "quality": _latest_quality(),
    }


def _latest_quality() -> dict | None:
    reports = sorted(config.REPORTS_DIR.glob("quality_*.json"))
    if not reports:
        return None
    body = json.loads(reports[-1].read_text())
    summary = body.get("summary")
    if summary is None:  # reports written before summaries were added
        summary = {name: len(rows) for name, rows in body.items()}
    return {"report": reports[-1].name, "checks": summary}
