"""Research data API consumed by the Spring Boot backend (not exposed to browsers directly).

Run: niftyquant serve  (defaults to http://127.0.0.1:8001)
"""

import html
import json
import logging
import math
from contextlib import asynccontextmanager
from datetime import date

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from . import analytics, config, live
from .store import Manifest

log = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Resume the Fyers feed if today's token is still valid, so bars are recorded after an API
    restart even with no dashboard open."""
    try:
        live.view()
    except Exception as e:  # the API must start even if the feed cannot
        log.warning("live feed not resumed: %s", e)
    yield


app = FastAPI(title="niftyquant research API", version="0.1.0", lifespan=_lifespan)


def _clean(value):
    """Make pandas/numpy values JSON-safe: NaN -> None, numpy scalars -> Python, dates -> ISO."""
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (np.floating, float)):
        return None if math.isnan(value) else float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, pd.Timestamp) and value.tzinfo is not None:
        return value.isoformat()  # a real moment in time (e.g. event_time_ist): keep time and offset
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


@app.get("/market/events")
def market_events(start: date | None = None, end: date | None = None, category: str | None = None) -> list[dict]:
    """Event calendar with Nifty's reaction (see events.py)."""
    from . import events
    df = analytics.load_derived(events.FILE)
    if df.empty:
        raise HTTPException(503, "events not built; run `niftyquant derive`")
    df = df.rename(columns={"event_date": "trade_date"})
    df = _between(df, start, end).rename(columns={"trade_date": "event_date"})
    if category:
        df = df[df["category"] == category]
    return _records(df)


@app.get("/market/events/impact")
def market_event_impact() -> list[dict]:
    """Per event category: Nifty's move on reaction sessions against all sessions."""
    from . import events
    df = analytics.load_derived(events.IMPACT_FILE)
    if df.empty:
        raise HTTPException(503, "events not built; run `niftyquant derive`")
    return _records(df)


@app.get("/market/results")
def market_results(start: date | None = None, end: date | None = None, symbol: str | None = None) -> list[dict]:
    """Quarterly results of the heavyweights, by reaction session (see results.py)."""
    from . import results
    df = analytics.load_derived(results.FILE)
    if df.empty:
        raise HTTPException(503, "results not built; run `niftyquant results` or `niftyquant derive`")
    df = df.rename(columns={"reaction_session": "trade_date"})
    df = _between(df, start, end).rename(columns={"trade_date": "reaction_session"})
    if symbol:
        df = df[df["symbol"] == symbol.upper()]
    return _records(df)


@app.get("/market/results/summary")
def market_results_summary() -> list[dict]:
    """Per heavyweight (and ALL): results moves against what options priced in, and Nifty impact."""
    from . import results
    df = analytics.load_derived(results.SUMMARY_FILE)
    if df.empty:
        raise HTTPException(503, "results not built; run `niftyquant results` or `niftyquant derive`")
    return _records(df)


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


# ---------------------------------------------------------------- live view (see live.py)

@app.get("/live")
def live_view() -> dict:
    """Market clock (open / pre-open / closed), Fyers feed state and live quotes (else last close)."""
    return live.view()


@app.get("/live/fyers/login")
def fyers_login():
    """Opened in the browser: sends it to Fyers' login page, which comes back to the callback."""
    s = live.FyersSettings.from_env()
    if s is None:
        raise HTTPException(503, "Fyers is not configured: set FYERS_APP_ID and FYERS_SECRET_KEY in .env")
    return RedirectResponse(live.login_url(s))


def _page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        f"<title>{html.escape(title)}</title><body style='font:16px system-ui;background:#0b0f17;color:#e6e9ef;"
        f"max-width:36rem;margin:15vh auto;padding:0 16px'><h1 style='font-size:1.3rem'>{html.escape(title)}</h1>"
        f"<p>{body}</p></body>")


@app.get("/live/fyers/callback", response_class=HTMLResponse)
def fyers_callback(auth_code: str | None = None, state: str | None = None, s: str | None = None,
                   message: str | None = None):
    """Fyers redirects here after login with an auth code, exchanged for today's access token."""
    settings = live.FyersSettings.from_env()
    if settings is None:
        return _page("Fyers is not configured", "Set FYERS_APP_ID and FYERS_SECRET_KEY in .env.")
    if not auth_code:
        return _page("Fyers login failed", html.escape(message or s or "Fyers sent no auth code."))
    if not live.take_login_state(state):
        return _page("Login link expired", "Start the login again from the dashboard.")
    try:
        live.save_token(live.exchange_auth_code(settings, auth_code))
    except (live.FyersError, OSError) as e:
        return _page("Fyers login failed", html.escape(str(e)))
    live.view()  # start the feed now rather than on the next dashboard poll
    return _page("Fyers connected", "Live prices are streaming. You can close this tab and go back to the dashboard.")
