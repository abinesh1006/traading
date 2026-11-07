"""Quarterly results of the Nifty heavyweights (stocks.UNIVERSE): what options priced in beforehand,
how the stock and Nifty reacted, and how much of the move was the stock's own.

Calendar. Each (symbol, quarter) needs the reaction session: the first session that could trade on
the result (the same day if it came out during market hours, the next session if after the close).
Sessions confirmed from news reports (CONFIRMED) are used as they are. For the rest, until an
exchange source of announcement times is wired in, the session is inferred (source "inferred"):
implied volatility rises into a scheduled result and collapses once it is out, so it is the session
inside the SEBI reporting window with the largest drop in the stock's ATM IV beyond the market's
(the market's 30-day IV drop scaled to the stock's IV level, so an election-day calm-down is not
mistaken for a result). On the 15 confirmed announcements this finds 13 (validate()); it misses
results so bad that IV rose instead of falling (HDFC Bank, 17 Jan 2024). Adding abnormal return or
volume as signals did worse (11 of 15): they also fire on unscheduled news (RBI's action on Kotak
Bank, 25 Apr 2024).

Measures per announcement (pre_session = the session before the reaction session):
- implied_move_pct: the event's one-day standard deviation priced in at the pre_session close,
  from the two nearest expiries that include the reaction session (Dubinsky-Johannes: total
  variance sigma_i^2 T_i = sigma_d^2 T_i + E for both, so E = T1 T2 (sigma1^2 - sigma2^2) / (T2 - T1)).
- return_pct, gap_pct: reaction-session close and open against NSE's adjusted previous close.
- drift_3d_pct / pre_drift_5d_pct: the 3 sessions after and the 5 sessions before.
- abnormal_return_pct: return_pct - beta x Nifty return; beta from 250 sessions of daily returns
  ending 5 sessions before the pre_session.
- surprise: |return_pct| / implied_move_pct.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import analytics, stockiv, stocks

log = logging.getLogger(__name__)

FILE = "result_events.parquet"
SUMMARY_FILE = "result_summary.parquet"
REPORT_LAG_DAYS = 5                            # no result reacts sooner than this after quarter end
DEADLINE_DAYS = {1: 45, 2: 45, 3: 45, 4: 60}   # SEBI LODR regulation 33, by fiscal quarter
DEADLINE_EXCEPTIONS = {date(2020, 3, 31): date(2020, 7, 31),   # COVID-19 relaxations by SEBI
                       date(2020, 6, 30): date(2020, 9, 15)}
DEADLINE_SLACK_DAYS = 4    # a filing after the close on the deadline, then a weekend
CRUSH_MIN_DAYS = 7         # measure the IV drop on the first expiry at least this far out
MARKET_SHOCK = 0.20        # sessions where the market's 30-day IV moved more than this share are skipped
BETA_SESSIONS, BETA_GAP, BETA_MIN = 250, 5, 120

# Reaction sessions confirmed from news reports of the announcement (searched 2026-11-07). They
# replace the inferred session for that quarter, and measure how often the inference is right.
# (symbol, quarter) -> (reaction session, announcement as reported)
CONFIRMED = {
    ("TCS", "Q3 FY18"): (date(2018, 1, 12), "11 Jan 2018, after the close"),
    ("AXISBANK", "Q4 FY19"): (date(2019, 4, 26), "25 Apr 2019, after market hours"),
    ("ITC", "Q3 FY21"): (date(2021, 2, 12), "11 Feb 2021; fell in early trade on Friday"),
    ("INFY", "Q2 FY23"): (date(2022, 10, 14), "13 Oct 2022 (with Rs 9,300 cr buyback); rose next day"),
    ("SBIN", "Q4 FY23"): (date(2023, 5, 18), "18 May 2023, during market hours"),
    ("ICICIBANK", "Q1 FY24"): (date(2023, 7, 24), "Saturday 22 Jul 2023"),
    ("RELIANCE", "Q2 FY24"): (date(2023, 10, 30), "Friday 27 Oct 2023, after the close"),
    ("LT", "Q2 FY24"): (date(2023, 11, 1), "31 Oct 2023, after the close"),
    ("HDFCBANK", "Q3 FY19"): (date(2019, 1, 21), "Saturday 19 Jan 2019"),
    ("HDFCBANK", "Q1 FY20"): (date(2019, 7, 22), "Saturday 20 Jul 2019"),
    ("HDFCBANK", "Q3 FY20"): (date(2020, 1, 20), "Saturday 18 Jan 2020"),
    ("HDFCBANK", "Q2 FY21"): (date(2020, 10, 19), "Saturday 17 Oct 2020"),
    ("HDFCBANK", "Q3 FY22"): (date(2022, 1, 17), "Saturday 15 Jan 2022"),
    ("HDFCBANK", "Q4 FY22"): (date(2022, 4, 18), "Saturday 16 Apr 2022"),
    ("HDFCBANK", "Q2 FY23"): (date(2022, 10, 17), "Saturday 15 Oct 2022"),
    ("HDFCBANK", "Q4 FY23"): (date(2023, 4, 17), "Saturday 15 Apr 2023"),
    ("HDFCBANK", "Q3 FY24"): (date(2024, 1, 17), "16 Jan 2024; fell 8.5% on 17 Jan"),
    ("HDFCBANK", "Q1 FY25"): (date(2024, 7, 22), "Saturday 20 Jul 2024"),
    ("HDFCBANK", "Q4 FY25"): (date(2025, 4, 21), "Saturday 19 Apr 2025 (Friday was Good Friday)"),
    ("BAJFINANCE", "Q3 FY24"): (date(2024, 1, 30), "29 Jan 2024, after market hours"),
    ("BHARTIARTL", "Q3 FY24"): (date(2024, 2, 6), "5 Feb 2024, after the close"),
    ("KOTAKBANK", "Q4 FY24"): (date(2024, 5, 6), "Saturday 4 May 2024"),
    ("TCS", "Q1 FY25"): (date(2024, 7, 12), "11 Jul 2024, after the close"),
    ("INFY", "Q1 FY25"): (date(2024, 7, 19), "18 Jul 2024, after the close"),
    ("RELIANCE", "Q1 FY25"): (date(2024, 7, 22), "Friday 19 Jul 2024, after the close"),
}

COLUMNS = ["symbol", "quarter", "quarter_end", "reaction_session", "pre_session", "source",
           "inferred_session", "iv_drop_pts", "market_iv_drop_pts", "idio_iv_drop_pts", "detect_score", "detect_margin",
           "pre_close", "gap_pct", "return_pct", "drift_3d_pct", "pre_drift_5d_pct",
           "implied_move_pct", "straddle_pct", "surprise", "iv_pre", "iv_post",
           "beta", "nifty_return_pct", "abnormal_return_pct", "volume_ratio", "nifty_iv30_change",
           "nifty_weight_pct", "nifty_move_points", "nifty_points", "nifty_abnormal_points",
           "share_of_nifty_move_pct"]


def quarter_label(qe: date) -> str:
    """Indian fiscal quarter: June quarter = Q1 of the fiscal year ending next March."""
    q = {6: 1, 9: 2, 12: 3, 3: 4}[qe.month]
    fy = qe.year + 1 if qe.month >= 4 else qe.year
    return f"Q{q} FY{fy % 100:02d}"


def report_window(qe: date) -> tuple[date, date]:
    """Calendar days in which the result for quarter-end qe reacts."""
    deadline = DEADLINE_EXCEPTIONS.get(qe) or qe + timedelta(days=DEADLINE_DAYS[int(quarter_label(qe)[1])])
    return qe + timedelta(days=REPORT_LAG_DAYS), deadline + timedelta(days=DEADLINE_SLACK_DAYS)


def quarter_ends(start: date, end: date) -> list[date]:
    """Quarter ends whose reporting window lies within [start, end]."""
    out = []
    for y in range(start.year - 1, end.year + 1):
        out += [date(y, 3, 31), date(y, 6, 30), date(y, 9, 30), date(y, 12, 31)]
    return [q for q in out if report_window(q)[0] >= start and report_window(q)[0] <= end]


# --- daily stock panel ---------------------------------------------------------------------

def stock_returns(cm: pd.DataFrame, market_return_pct: pd.Series | None = None) -> pd.DataFrame:
    """Daily return, gap and volume per symbol from the cash market (series EQ), against the
    previous close adjusted for splits and bonuses (stocks.adjust; NSE's own prev_close is not)."""
    eq = cm[cm["series"] == "EQ"][["trade_date", "symbol", "open", "close", "prev_close", "volume_shares"]]
    eq = stocks.adjust(eq, market_return_pct if market_return_pct is not None else pd.Series(dtype=float))
    eq["symbol"] = eq["symbol"].astype(object)
    eq["prev_close"] = eq["adj_prev_close"]
    eq["return_pct"] = (eq["close"] / eq["prev_close"] - 1) * 100
    eq["gap_pct"] = (eq["open"] / eq["prev_close"] - 1) * 100
    return eq.drop(columns=["adj_prev_close"]).sort_values(["symbol", "trade_date"]).reset_index(drop=True)


def iv_drops(iv: pd.DataFrame, market_iv: pd.Series) -> pd.DataFrame:
    """Per (symbol, session): ATM IV drop since the previous session on one fixed expiry (the first
    with >= CRUSH_MIN_DAYS left), the market's 30-day IV drop scaled to the stock's IV level
    (a stock at twice the index's IV drops about twice as many points in a market-wide calm-down),
    and the remainder."""
    iv = iv[["trade_date", "symbol", "expiry", "days_to_expiry", "atm_iv"]]
    sessions = sorted(iv["trade_date"].unique())
    prev = dict(zip(sessions[1:], sessions[:-1]))
    cur = (iv[(iv["days_to_expiry"] >= CRUSH_MIN_DAYS) & iv["atm_iv"].notna()]
           .sort_values(["trade_date", "symbol", "expiry"])
           .drop_duplicates(["trade_date", "symbol"]))
    cur = cur.assign(pre_session=cur["trade_date"].map(prev)).dropna(subset=["pre_session"])
    pre = iv.rename(columns={"trade_date": "pre_session", "atm_iv": "iv_pre"})[["pre_session", "symbol", "expiry", "iv_pre"]]
    out = cur.merge(pre, on=["pre_session", "symbol", "expiry"], how="inner").rename(columns={"atm_iv": "iv_post"})
    out["iv_drop_pts"] = out["iv_pre"] - out["iv_post"]
    m = market_iv.sort_index()
    mk = pd.DataFrame({"market_drop": m.shift(1) - m, "market_pre": m.shift(1)})
    out = out.merge(mk, left_on="trade_date", right_index=True, how="left")
    out["market_iv_drop_pts"] = (out["market_drop"] * out["iv_pre"] / out["market_pre"]).fillna(0)
    out["idio_iv_drop_pts"] = out["iv_drop_pts"] - out["market_iv_drop_pts"]
    # On a market-wide volatility shock (7 Apr 2025: India VIX +50%) every stock's IV moves by its
    # own amount, and the difference says nothing about a result; such sessions are not read.
    out["market_shock"] = (out["market_drop"].abs() / out["market_pre"]) > MARKET_SHOCK
    return (out.drop(columns=["market_drop", "market_pre"])
            .rename(columns={"trade_date": "reaction_session"}).reset_index(drop=True))


def _robust_z(x: pd.Series) -> pd.Series:
    """(x - median) / (1.4826 x median absolute deviation); the std if the MAD is zero."""
    med = x.median()
    mad = 1.4826 * (x - med).abs().median()
    scale = mad if mad > 0 else x.std()
    return (x - med) / scale if scale and np.isfinite(scale) else x * 0


def infer_calendar(drops: pd.DataFrame, start: date, end: date) -> pd.DataFrame:
    """One row per (symbol, quarter): the session in the reporting window with the largest
    idiosyncratic IV drop (every company reports once in the window, so one is always chosen).
    detect_score: that drop's robust z-score against the symbol's other days in the window;
    detect_margin: how far it is ahead of the runner-up. Both small = an unclear pick."""
    rows = []
    for qe in quarter_ends(start, end):
        lo, hi = report_window(qe)
        w = drops[(drops["reaction_session"] >= lo) & (drops["reaction_session"] <= hi)]
        for sym, g in w.groupby("symbol"):
            g = g.dropna(subset=["idio_iv_drop_pts"])
            g = g[~g["market_shock"]] if "market_shock" in g else g
            if len(g) < 10:
                continue
            z = _robust_z(g["idio_iv_drop_pts"]).sort_values(ascending=False)
            best = g.loc[z.index[0]]
            rows.append({"symbol": sym, "quarter": quarter_label(qe), "quarter_end": qe,
                         "reaction_session": best["reaction_session"], "source": "inferred",
                         "iv_drop_pts": best["iv_drop_pts"], "market_iv_drop_pts": best["market_iv_drop_pts"],
                         "idio_iv_drop_pts": best["idio_iv_drop_pts"], "detect_score": float(z.iloc[0]),
                         "detect_margin": float(z.iloc[0] - z.iloc[1])})
    return pd.DataFrame(rows)


# --- measures per announcement -------------------------------------------------------------

def implied_event_move(iv_pre: pd.DataFrame, reaction: date) -> tuple[float, float]:
    """(implied one-day event move %, straddle % of the first expiry covering the event) from the
    pre-session's IV term structure. NaN where fewer than two expiries cover it or E <= 0."""
    cov = iv_pre[(iv_pre["expiry"] >= reaction) & iv_pre["atm_iv"].notna()].sort_values("expiry")
    straddle = float(cov["straddle_pct"].iloc[0]) if len(cov) else np.nan
    if len(cov) < 2:
        return np.nan, straddle
    (s1, t1), (s2, t2) = [(r.atm_iv / 100, r.days_to_expiry / 365) for r in cov.iloc[:2].itertuples()]
    if t2 <= t1:
        return np.nan, straddle
    e = t1 * t2 * (s1 ** 2 - s2 ** 2) / (t2 - t1)
    return (100 * float(np.sqrt(e)) if e > 0 else np.nan), straddle


def _beta(sr: pd.Series, nr: pd.Series, pre: date) -> float:
    """OLS beta of stock on Nifty daily returns over BETA_SESSIONS ending BETA_GAP sessions before pre."""
    j = pd.concat({"s": sr, "n": nr}, axis=1, join="inner").dropna()
    j = j[j.index < pre]
    j = j.iloc[-(BETA_SESSIONS + BETA_GAP):-BETA_GAP] if len(j) > BETA_GAP else j.iloc[:0]
    if len(j) < BETA_MIN:
        return np.nan
    return float(np.cov(j["s"], j["n"])[0, 1] / np.var(j["n"], ddof=1))


def _compound(r: pd.Series) -> float:
    return float(((1 + r / 100).prod() - 1) * 100) if len(r) else np.nan


def measure(cal: pd.DataFrame, rets: pd.DataFrame, iv: pd.DataFrame, dm: pd.DataFrame,
            market_iv: pd.Series, weights: pd.DataFrame | None = None) -> pd.DataFrame:
    """Add the reaction measures to a calendar (symbol, quarter, quarter_end, reaction_session, source).
    weights (nifty_weights.build) adds the Nifty impact: the stock's index weight at the pre_session
    close, the Nifty points it contributed on the reaction session (all of it, and the part from its
    abnormal move), and that contribution as a share of the Nifty's move that day."""
    nifty = dm.set_index("trade_date")["spot_return_pct"]
    level = dm.set_index("trade_date")["spot_close"]
    wt = (weights.set_index(["trade_date", "symbol"]) if weights is not None and not weights.empty
          else pd.DataFrame(columns=["weight_pct", "points"]))
    sessions = sorted(dm["trade_date"])
    pos = {d: i for i, d in enumerate(sessions)}
    by_sym = {s: g.set_index("trade_date") for s, g in rets.groupby("symbol")}
    iv_by = {k: g for k, g in iv.groupby(["trade_date", "symbol"])}
    out = []
    for r in cal.itertuples(index=False):
        row = r._asdict()
        t = r.reaction_session
        st = by_sym.get(r.symbol)
        if st is None or t not in pos or t not in st.index or pos[t] == 0:
            out.append(row)
            continue
        i = pos[t]
        pre = sessions[i - 1]
        day = st.loc[t]
        after = st.loc[[d for d in sessions[i + 1:i + 4] if d in st.index], "return_pct"]
        before = st.loc[[d for d in sessions[max(0, i - 5):i] if d in st.index], "return_pct"]
        vol_hist = st.loc[[d for d in sessions[max(0, i - 21):i - 1] if d in st.index], "volume_shares"]
        move, straddle = implied_event_move(iv_by.get((pre, r.symbol), iv.iloc[:0]), t)
        beta = _beta(st["return_pct"], nifty, pre)
        n_ret = float(nifty.get(t, np.nan))
        pre_iv = iv_by.get((pre, r.symbol), iv.iloc[:0])
        post_iv = iv_by.get((t, r.symbol), iv.iloc[:0])
        e = pre_iv[(pre_iv["expiry"] >= t) & pre_iv["atm_iv"].notna()].sort_values("expiry")
        iv_pre = float(e["atm_iv"].iloc[0]) if len(e) else np.nan
        iv_post = np.nan
        if len(e):
            p = post_iv[post_iv["expiry"] == e["expiry"].iloc[0]]
            iv_post = float(p["atm_iv"].iloc[0]) if len(p) else np.nan
        row |= {
            "pre_session": pre, "pre_close": float(day["prev_close"]),
            "gap_pct": float(day["gap_pct"]), "return_pct": float(day["return_pct"]),
            "drift_3d_pct": _compound(after) if len(after) == 3 else np.nan,
            "pre_drift_5d_pct": _compound(before) if len(before) == 5 else np.nan,
            "implied_move_pct": move, "straddle_pct": straddle,
            "surprise": abs(float(day["return_pct"])) / move if move and np.isfinite(move) else np.nan,
            "iv_pre": iv_pre, "iv_post": iv_post,
            "beta": beta, "nifty_return_pct": n_ret,
            "abnormal_return_pct": float(day["return_pct"]) - beta * n_ret if np.isfinite(beta) else np.nan,
            "volume_ratio": float(day["volume_shares"] / vol_hist.median()) if len(vol_hist) >= 10 else np.nan,
            "nifty_iv30_change": float(market_iv.get(t, np.nan) - market_iv.get(pre, np.nan)),
        }
        w_pre = float(wt["weight_pct"].get((pre, r.symbol), np.nan))
        pts = float(wt["points"].get((t, r.symbol), np.nan))
        move = float(level.get(t, np.nan) - level.get(pre, np.nan))
        row |= {
            "nifty_weight_pct": w_pre, "nifty_move_points": move, "nifty_points": pts,
            "nifty_abnormal_points": w_pre / 100 * row["abnormal_return_pct"] / 100 * float(level.get(pre, np.nan)),
            "share_of_nifty_move_pct": 100 * pts / move if move and np.isfinite(move) and abs(move) > 1e-9 else np.nan,
        }
        out.append(row)
    return pd.DataFrame(out).reindex(columns=COLUMNS)


def summarize(ev: pd.DataFrame) -> pd.DataFrame:
    """Per symbol, plus an ALL row: how much results moved the stock against what options priced in."""
    if ev.empty:
        return pd.DataFrame()

    def agg(g: pd.DataFrame) -> dict:
        ok = g.dropna(subset=["return_pct"])
        priced = ok.dropna(subset=["implied_move_pct"])
        return {
            "announcements": len(ok),
            "median_abs_move_pct": ok["return_pct"].abs().median(),
            "median_implied_move_pct": priced["implied_move_pct"].median(),
            "beat_implied_share": (priced["surprise"] > 1).mean() if len(priced) else np.nan,
            "median_abs_abnormal_pct": ok["abnormal_return_pct"].abs().median(),
            "median_iv_drop_pts": ok["iv_drop_pts"].median(),
            "up_share": (ok["return_pct"] > 0).mean() if len(ok) else np.nan,
            "drift_follows_share": (np.sign(ok["drift_3d_pct"]) == np.sign(ok["return_pct"]))[ok["drift_3d_pct"].notna()].mean(),
            "median_abs_nifty_points": ok["nifty_points"].abs().median(),
            "max_abs_nifty_points": ok["nifty_points"].abs().max(),
            "median_nifty_weight_pct": ok["nifty_weight_pct"].median(),
        }
    rows = [{"symbol": s, **agg(g)} for s, g in ev.groupby("symbol")]
    rows.append({"symbol": "ALL", **agg(ev)})
    return pd.DataFrame(rows)


# --- build ---------------------------------------------------------------------------------

def build() -> pd.DataFrame:
    iv = stockiv.read()
    if iv.empty:
        return pd.DataFrame(columns=COLUMNS)
    dm = analytics.load_derived(analytics.DAILY_MARKET)
    ivd = analytics.load_derived(analytics.IV_DAILY)
    market_iv = ivd.set_index("trade_date")["iv_30d"]
    start, end = min(iv["trade_date"]), max(iv["trade_date"])
    rets = stock_returns(stocks.read_cm(start - timedelta(days=500), end, symbols=list(stocks.UNIVERSE)),
                         dm.set_index("trade_date")["spot_return_pct"])
    drops = iv_drops(iv, market_iv)
    cal = apply_confirmed(infer_calendar(drops, start, end), drops)
    from . import nifty_weights
    ev = measure(cal, rets, iv, dm, market_iv, analytics.load_derived(nifty_weights.FILE))
    return ev.sort_values(["reaction_session", "symbol"]).reset_index(drop=True)


def quarter_end_of(label: str) -> date:
    """Inverse of quarter_label: 'Q3 FY24' -> 2023-12-31."""
    q, fy = int(label[1]), 2000 + int(label[-2:])
    return {1: date(fy - 1, 6, 30), 2: date(fy - 1, 9, 30), 3: date(fy - 1, 12, 31), 4: date(fy, 3, 31)}[q]


def apply_confirmed(cal: pd.DataFrame, drops: pd.DataFrame, confirmed: dict | None = None) -> pd.DataFrame:
    """Use confirmed reaction sessions where known; keep the inferred one in inferred_session."""
    confirmed = CONFIRMED if confirmed is None else confirmed
    cal = cal.assign(inferred_session=cal["reaction_session"]) if len(cal) else \
        pd.DataFrame(columns=[*cal.columns, "inferred_session"])
    stats = ["iv_drop_pts", "market_iv_drop_pts", "idio_iv_drop_pts"]
    at = drops.set_index(["symbol", "reaction_session"])[stats]
    for (sym, q), (sess, _) in confirmed.items():
        m = (cal["symbol"] == sym) & (cal["quarter"] == q)
        if not m.any():
            cal = pd.concat([cal, pd.DataFrame([{"symbol": sym, "quarter": q, "quarter_end": quarter_end_of(q),
                                                 "inferred_session": None}])], ignore_index=True)
            m = (cal["symbol"] == sym) & (cal["quarter"] == q)
        cal.loc[m, "reaction_session"] = sess
        cal.loc[m, "source"] = "confirmed"
        cal.loc[m, stats] = at.loc[(sym, sess)].to_numpy() if (sym, sess) in at.index else np.nan
    return cal


def validate(ev: pd.DataFrame) -> pd.DataFrame:
    """Confirmed announcements: did the IV-drop inference pick the same session?"""
    c = ev[ev["source"] == "confirmed"][["symbol", "quarter", "reaction_session", "inferred_session"]].copy()
    c["match"] = c["reaction_session"] == c["inferred_session"]
    return c.reset_index(drop=True)


WEAK_ACCURACY, WEAK_MIN_CONFIRMED = 0.8, 3


def check(ev: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Inferred result dates that need confirming: those of stocks whose confirmed dates the
    inference mostly misses (HDFC Bank). Confirm them from news and add them to CONFIRMED."""
    if ev.empty:
        return {"results_missing": pd.DataFrame({"message": ["no results; run `niftyquant results`"]})}
    v = validate(ev)
    acc = v.groupby("symbol")["match"].agg(["mean", "size"])
    weak = acc[(acc["size"] >= WEAK_MIN_CONFIRMED) & (acc["mean"] < WEAK_ACCURACY)].index
    todo = ev[(ev["source"] == "inferred") & ev["symbol"].isin(weak)]
    return {"result_dates_to_confirm": todo[["symbol", "quarter", "reaction_session", "detect_score"]]}
