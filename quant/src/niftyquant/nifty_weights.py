"""Nifty 50 constituent weights, estimated from prices alone.

The index is a free-float market-cap sum of its members divided by a divisor, so between changes to
the member list or share counts its daily change in points is a fixed linear combination of the
members' price changes: dI_t = sum_i c_i dP_i,t, with c_i = free-float shares_i / divisor. Price
changes are taken against the split/bonus-adjusted previous close (stocks.adjust) and carried in the
window's starting units, which keeps c_i constant across those events.

Each window (a half-year between the semi-annual reconstitutions, split further at BREAKS) is fitted
by non-negative least squares on the most-traded company shares (swept in batches, see
fit_window), then
    weight_i,t = c_i P_i,t / I_t        points_i,t = c_i dP_i,t (Nifty points from stock i on day t).
The candidates must include every member: with too few, a missing member's moves leak into its
peers. The fit is checked by the residual (index points per day the members do not explain) and
by the weights summing to about 100%. Over 2018-2026 every window but one fits within 1.4 index
points a day (most within 0.6) with weights summing to 98-102%; the exception, Jul 2023 - Mar 2024,
fits within 2.6. Recovered weights match the published ones to a few tenths of a point (for
example HDFC Bank 11.6%, Reliance 9.8%, ICICI Bank 7.6% in Jan 2024).
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd
from scipy.optimize import nnls

from . import analytics, stocks

log = logging.getLogger(__name__)

FILE = "nifty_weights.parquet"
FIT_FILE = "nifty_weight_fits.parquet"
CANDIDATES = 150     # names in one fit (capped below the number of sessions in the window)
POOL = 400           # most-traded company shares swept through the fit
MIN_OBS = 40
PRESENCE = 0.95      # a candidate must trade on this share of the window's sessions
OUTLIER_MADS = 6     # days whose residual is beyond this many MADs are left out of the refit
# Changes to members or share counts inside a half-year: HDFC Ltd merged into HDFC Bank and left
# the index (HDFC's last trading day 2023-07-12); ITC Hotels demerged from ITC (ex-date 2025-01-06)
# and sat in the index for a few sessions.
BREAKS = (date(2023, 7, 13), date(2025, 1, 6))
# Reconstitution edges not used: after the HDFC merger only 55 sessions remained until Oct 2023,
# too few to fit the 51 members of the time (Jio Financial sat in the index for six weeks), and
# the September 2023 review changed little, so Jul 2023 - Mar 2024 is fitted as one window.
SKIP_EDGES = (date(2023, 10, 1),)
COLUMNS = ["trade_date", "symbol", "weight_pct", "points", "window_start"]


def windows(start: date, end: date) -> list[tuple[date, date]]:
    """Half-years Apr-Sep and Oct-Mar (NSE reconstitutes Nifty at the end of March and September),
    split at BREAKS, clipped to [start, end]."""
    edges = {start, end + timedelta(days=1), *[b for b in BREAKS if start < b <= end]}
    for y in range(start.year - 1, end.year + 2):
        for m in (4, 10):
            d = date(y, m, 1)
            if start < d <= end and d not in SKIP_EDGES:
                edges.add(d)
    e = sorted(edges)
    return [(a, b - timedelta(days=1)) for a, b in zip(e[:-1], e[1:])]


def _price_changes(cm: pd.DataFrame, market_return_pct: pd.Series) -> pd.DataFrame:
    """Per (symbol, day): price change and price in the window's starting units. Company shares only
    (ISIN prefix INE): ETFs trade in series EQ too (INF, mutual-fund units), and an index ETF would
    "explain" the index by itself while a liquid-fund ETF's flat price leaves its coefficient free."""
    w = cm[(cm["series"] == "EQ") & cm["isin"].astype(str).str.startswith("INE")]
    w = stocks.adjust(w[["trade_date", "symbol", "close", "prev_close", "turnover_inr"]], market_return_pct)
    w["symbol"] = w["symbol"].astype(object)
    w = w.sort_values(["symbol", "trade_date"])
    # Carry prices in the window's starting units: a 1:1 bonus halves the price and doubles the
    # shares, so dividing by the cumulative ratio keeps c_i constant across it. NSE's prev_close
    # (not the previous row's close) also bridges sessions missing from the store.
    cum = w["ca_factor"].groupby(w["symbol"]).cumprod()
    w["dP"] = (w["close"] - w["adj_prev_close"]) / cum
    w["P"] = w["close"] / cum
    return w


def fit_window(cm: pd.DataFrame, nifty: pd.Series, candidates: int = CANDIDATES):
    """(coefficients c_i, price-change panel, fit stats) for one window, or None if too short."""
    w = _price_changes(cm, nifty.pct_change() * 100)
    n_days = w["trade_date"].nunique()
    # Members trade every session. A stock listed (or suspended) part-way through the window has
    # zero price change on the missing days, which leaves its coefficient free to soak up noise.
    present = w.groupby("symbol")["trade_date"].nunique()
    full = present[present >= PRESENCE * n_days].index
    pool = w[w["symbol"].isin(full)].groupby("symbol")["turnover_inr"].mean().nlargest(POOL).index
    X_all = w[w["symbol"].isin(pool)].pivot(index="trade_date", columns="symbol", values="dP").fillna(0.0)
    dI = nifty.diff().reindex(X_all.index)
    ok = dI.notna()
    X_all, b = X_all[ok][list(pool)], dI[ok].to_numpy()
    if len(X_all) < MIN_OBS:
        return None
    size = min(candidates, max(10, len(X_all) - 5))  # keep each fit overdetermined

    def sweep(rows: np.ndarray) -> pd.Series:
        """Sweep the pool by turnover: keep the names the fit uses, add the next batch, refit.
        Quiet members (Nestle, Britannia) can rank below busy mid-caps in turnover, so a single
        top-N cut leaves them out and their moves leak into their peers."""
        def solve(cols):
            c, _ = nnls(X_all[cols].to_numpy()[rows], b[rows], maxiter=20 * len(cols))
            return pd.Series(c, index=cols)
        cols, nxt = list(pool[:size]), size
        coef = solve(cols)
        while nxt < len(pool):
            used = [s for s in cols if coef[s] > 0]
            room = size - len(used)
            if room <= 0:
                break
            cols, nxt = used + list(pool[nxt:nxt + room]), nxt + room
            coef = solve(cols)
        return coef

    def residuals(coef: pd.Series) -> np.ndarray:
        return b - X_all[coef.index].to_numpy() @ coef.to_numpy()

    keep = np.ones(len(b), dtype=bool)
    coef = sweep(keep)
    res = residuals(coef)
    # Redo the sweep without outlier days (e.g. 24 Feb 2021, when an NSE outage delayed the close),
    # which would otherwise steer which names get picked.
    mad = 1.4826 * np.median(np.abs(res - np.median(res)))
    out = np.abs(res) > max(OUTLIER_MADS * mad, 1.0)
    if out.any() and (~out).sum() >= MIN_OBS:
        keep = ~out
        coef = sweep(keep)
        res = residuals(coef)
    X = X_all[coef.index]
    last = X.index[-1]
    p_last = w[w["trade_date"] == last].set_index("symbol")["P"].reindex(coef.index).fillna(0)
    stats = {"obs": len(X), "outlier_days": int((~keep).sum()), "candidates": X.shape[1],
             "members_found": int((coef > 0).sum()),
             "residual_sd_points": float(res[keep].std()), "max_abs_residual_points": float(np.abs(res).max()),
             "weight_sum_pct": float((coef * p_last).sum() / nifty.get(last, np.nan) * 100)}
    return coef, w, stats


def build(symbols=stocks.UNIVERSE) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Daily weight and points contribution for `symbols`, plus one row of fit stats per window."""
    dm = analytics.load_derived(analytics.DAILY_MARKET)
    if dm.empty:
        return pd.DataFrame(columns=COLUMNS), pd.DataFrame()
    nifty = dm.set_index("trade_date")["spot_close"].sort_index()
    days = stocks.sessions(date(2000, 1, 1))
    cm_days = [d for d in days if stocks.has_day(stocks.CM, d)]
    if not cm_days:
        return pd.DataFrame(columns=COLUMNS), pd.DataFrame()
    out, fits = [], []
    for lo, hi in windows(cm_days[0], cm_days[-1]):
        cm = stocks.read_cm(lo, hi)
        if cm.empty:
            continue
        r = fit_window(cm, nifty)
        if r is None:
            log.info("nifty weights: %s - %s too short, skipped", lo, hi)
            continue
        coef, w, stats = r
        fits.append({"window_start": lo, "window_end": hi, **stats})
        u = w[w["symbol"].isin(symbols)].copy()
        u["c"] = u["symbol"].map(coef).fillna(0.0)
        level = u["trade_date"].map(nifty)
        u["weight_pct"] = u["c"] * u["P"] / level * 100
        u["points"] = u["c"] * u["dP"]
        u["window_start"] = lo
        out.append(u[COLUMNS])
        log.info("nifty weights %s - %s: residual %.1f points/day, weights sum %.1f%%",
                 lo, hi, stats["residual_sd_points"], stats["weight_sum_pct"])
    df = pd.concat(out, ignore_index=True) if out else pd.DataFrame(columns=COLUMNS)
    return df.sort_values(["trade_date", "symbol"]).reset_index(drop=True), pd.DataFrame(fits)


FIT_RESIDUAL_MAX = 3.0     # index points per day
FIT_SUM_TOLERANCE = 5.0    # percentage points around 100%


def check(fits: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Fit windows whose weights reproduce the index poorly (a member or share change mid-window)."""
    if fits.empty:
        return {"nifty_weights_missing": pd.DataFrame({"message": ["no weight fits; run `niftyquant derive`"]})}
    bad = fits[(fits["residual_sd_points"] > FIT_RESIDUAL_MAX)
               | ((fits["weight_sum_pct"] - 100).abs() > FIT_SUM_TOLERANCE)]
    return {"nifty_weight_fit_poor": bad}
