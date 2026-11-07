"""Implied volatility and Greeks for every Nifty option, from end-of-day prices (Black-76).

Model
- Underlying is the forward for each expiry, from put-call parity on strikes near the money where
  both the call and the put traded:  F = K + e^{rT} (C - P), median over the 5 nearest strikes.
  This absorbs dividends and the futures basis, and works for weekly expiries that have no future.
  Fallbacks: the future for that expiry, then spot x e^{rT}.
- T = calendar days to expiry / 365. Expiry-day rows (T = 0) get no IV.
- r = RBI repo rate on the day (see rates.py); it only discounts, so its effect on IV is tiny.
- Price = NSE closing price, only for options that traded that day. Untraded strikes carry an
  exchange-computed price, not a market price, so they get no IV.

Units: iv_pct in % a year; delta per 1 point of the forward (futures delta); gamma per point;
theta in index points per calendar day; vega in points per 1 vol point.
"""

from __future__ import annotations

import logging
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import ndtr

from . import config
from .rates import repo_rate

log = logging.getLogger(__name__)

PARITY_STRIKES = 5
IV_LO, IV_HI = 1e-4, 5.0       # 0.01% .. 500% a year
BISECT_ITERS = 60              # bracket width 5 / 2^60: far below price tick precision
GREEK_COLUMNS = ["trade_date", "expiry", "strike", "option_type", "days_to_expiry", "rate", "forward",
                 "forward_source", "price", "iv_pct", "delta", "gamma", "theta", "vega"]


def _npdf(x):
    return np.exp(-0.5 * x * x) / np.sqrt(2 * np.pi)


def black76(F, K, T, r, sigma, is_call):
    """Black-76 option value on a forward. Arrays broadcast; T > 0, sigma > 0."""
    sq = sigma * np.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sq * sq) / sq
    d2 = d1 - sq
    df = np.exp(-r * T)
    call = df * (F * ndtr(d1) - K * ndtr(d2))
    put = df * (K * ndtr(-d2) - F * ndtr(-d1))
    return np.where(is_call, call, put)


def implied_vol(price, F, K, T, r, is_call):
    """Vectorised bisection; option value is increasing in sigma, so this always converges.
    NaN where the price is outside no-arbitrage bounds or T <= 0."""
    price, F, K, T = (np.asarray(a, dtype="float64") for a in (price, F, K, T))
    is_call = np.asarray(is_call, dtype=bool)
    Tpos = np.where(T > 0, T, 1.0)  # placeholder avoids division by zero; masked below
    df = np.exp(-r * Tpos)
    intrinsic = df * np.where(is_call, np.maximum(F - K, 0), np.maximum(K - F, 0))
    upper = df * np.where(is_call, F, K)
    ok = (T > 0) & np.isfinite(price) & np.isfinite(F) & (price > intrinsic) & (price < upper)
    lo = np.full(price.shape, IV_LO)
    hi = np.full(price.shape, IV_HI)
    for _ in range(BISECT_ITERS):
        mid = 0.5 * (lo + hi)
        above = black76(F, K, Tpos, r, mid, is_call) > price
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
    iv = 0.5 * (lo + hi)
    ok &= (iv > IV_LO * 1.01) & (iv < IV_HI * 0.99)  # pinned at a bound = no real solution
    return np.where(ok, iv, np.nan)


def greeks(F, K, T, r, sigma, is_call) -> dict[str, np.ndarray]:
    sq = sigma * np.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sq * sq) / sq
    df = np.exp(-r * T)
    value = black76(F, K, T, r, sigma, is_call)
    pdf = _npdf(d1)
    return {
        "delta": np.where(is_call, df * ndtr(d1), -df * ndtr(-d1)),
        "gamma": df * pdf / (F * sq),
        # dV/dt = rV - df F pdf sigma / (2 sqrt T), per calendar day
        "theta": (r * value - df * F * pdf * sigma / (2 * np.sqrt(T))) / 365,
        "vega": df * F * pdf * np.sqrt(T) / 100,
    }


def forward_for_expiry(rows: pd.DataFrame, T: float, r: float, ref: float,
                       future: float | None, spot: float | None) -> tuple[float, str]:
    """Forward for one expiry from put-call parity, else the future, else spot carried at r."""
    traded = rows[(rows["volume_contracts"] > 0) & (rows["close"] > 0)]
    ce = traded[traded["option_type"] == "CE"].set_index("strike")["close"]
    pe = traded[traded["option_type"] == "PE"].set_index("strike")["close"]
    both = pd.concat({"c": ce, "p": pe}, axis=1, join="inner")
    if len(both):
        strikes = both.index.to_numpy(dtype="float64")
        growth = np.exp(r * T)
        center = ref if np.isfinite(ref) else float(np.median(strikes))
        for _ in range(2):  # pick strikes around the reference, then around the first estimate
            near = both.iloc[np.argsort(np.abs(strikes - center))[:PARITY_STRIKES]]
            center = float(np.median(near.index.to_numpy() + growth * (near["c"] - near["p"]).to_numpy()))
        return center, "parity"
    if future is not None and np.isfinite(future):
        return float(future), "futures"
    if spot is not None and np.isfinite(spot):
        return float(spot * np.exp(r * T)), "spot"
    return np.nan, "none"


def day_greeks(fo: pd.DataFrame, d: date, spot: float | None) -> pd.DataFrame:
    """IV and Greeks for every option of one day with T > 0 (NaN where not computable)."""
    r = repo_rate(d)
    opt = fo[(fo["instrument"] == "OPT") & (fo["expiry"] > d)].copy()
    if opt.empty:
        return pd.DataFrame(columns=GREEK_COLUMNS)
    futs = fo[fo["instrument"] == "FUT"].sort_values("expiry")
    fut_by_expiry = dict(zip(futs["expiry"], futs["close"]))
    ref = spot if spot is not None and np.isfinite(spot) else (futs["close"].iloc[0] if len(futs) else np.nan)

    opt["days_to_expiry"] = opt["expiry"].map(lambda e: (e - d).days)
    opt["T"] = opt["days_to_expiry"] / 365.0
    fwd = {}
    for expiry, rows in opt.groupby("expiry"):
        T = (expiry - d).days / 365.0
        fwd[expiry] = forward_for_expiry(rows, T, r, ref, fut_by_expiry.get(expiry), spot)
    opt["forward"] = opt["expiry"].map(lambda e: fwd[e][0])
    opt["forward_source"] = opt["expiry"].map(lambda e: fwd[e][1])
    opt["rate"] = r

    traded = (opt["volume_contracts"] > 0) & (opt["close"] > 0)
    opt["price"] = opt["close"].where(traded)
    F, K, T = opt["forward"].to_numpy(), opt["strike"].to_numpy(), opt["T"].to_numpy()
    is_call = (opt["option_type"] == "CE").to_numpy()
    sigma = implied_vol(opt["price"].to_numpy(dtype="float64"), F, K, T, r, is_call)
    with np.errstate(invalid="ignore", divide="ignore"):
        g = greeks(F, K, T, r, sigma, is_call)
    opt["iv_pct"] = sigma * 100
    for k, v in g.items():
        opt[k] = v
    return opt[GREEK_COLUMNS].sort_values(["expiry", "strike", "option_type"]).reset_index(drop=True)


# --- daily volatility summary ---------------------------------------------------------------

LIQUID_SHARE = 0.005   # of the busiest strike's volume, same expiry and side
LIQUID_MIN = 10        # contracts


def liquid_mask(e: pd.DataFrame) -> pd.Series:
    """Strikes traded enough for the closing price to be current. A strike that traded a handful of
    contracts may have last traded hours before the close (13 Mar 2026: puts that traded 5-344
    contracts early in a falling day showed IVs 10 points under their liquid neighbours)."""
    if "volume_contracts" not in e:
        return pd.Series(True, index=e.index)
    vol = e["volume_contracts"].fillna(0)
    busiest = vol.groupby(e["option_type"]).transform("max")
    return vol >= np.maximum(LIQUID_MIN, LIQUID_SHARE * busiest)


def _otm_curve(e: pd.DataFrame) -> pd.DataFrame:
    """Out-of-the-money IVs on liquid strikes for one expiry: puts below the forward, calls at/above."""
    F = e["forward"].iloc[0]
    otm = ((e["option_type"] == "PE") & (e["strike"] < F)) | ((e["option_type"] == "CE") & (e["strike"] >= F))
    return e[otm & liquid_mask(e)].dropna(subset=["iv_pct"]).sort_values("strike")


def atm_iv(e: pd.DataFrame) -> float:
    """IV at strike = forward, interpolated between the OTM strikes either side of it."""
    c = _otm_curve(e)
    F = e["forward"].iloc[0]
    if len(c) < 2 or not (c["strike"].iloc[0] <= F <= c["strike"].iloc[-1]):
        return np.nan
    return float(np.interp(F, c["strike"], c["iv_pct"]))


def delta_iv(e: pd.DataFrame, target: float) -> float:
    """IV at a given delta (e.g. -0.25 put, +0.25 call), interpolated across OTM options."""
    c = _otm_curve(e)
    side = c[c["option_type"] == ("PE" if target < 0 else "CE")].sort_values("delta")
    if len(side) < 2 or not (side["delta"].iloc[0] <= target <= side["delta"].iloc[-1]):
        return np.nan
    return float(np.interp(target, side["delta"], side["iv_pct"]))


def summarize_iv(g: pd.DataFrame, d: date) -> dict:
    row: dict = {"trade_date": d}
    if g.empty:
        return row
    by_exp = {e: grp for e, grp in g.groupby("expiry")}
    expiries = sorted(by_exp)
    atm = {e: atm_iv(by_exp[e]) for e in expiries}
    days = {e: (e - d).days for e in expiries}

    row |= {"near_expiry": expiries[0], "near_atm_iv": atm[expiries[0]],
            "near_forward": float(by_exp[expiries[0]]["forward"].iloc[0])}
    if len(expiries) > 1:
        row |= {"next_expiry": expiries[1], "next_atm_iv": atm[expiries[1]]}

    # 30-day constant-maturity ATM IV, built like India VIX from monthly expiries only (the last
    # expiry of each month; far weeklies are thinly traded and their closing prices are noisy):
    # interpolate total variance between the monthlies either side of 30 days, ignoring < 3 days.
    monthly = {max(x for x in expiries if (x.year, x.month) == (e.year, e.month)) for e in expiries}
    pts = [(days[e], atm[e]) for e in expiries if e in monthly and days[e] >= 3 and np.isfinite(atm[e])]
    if pts:
        below = [p for p in pts if p[0] <= 30]
        above = [p for p in pts if p[0] >= 30]
        if below and above:
            (t1, v1), (t2, v2) = below[-1], above[0]
            if t1 == t2:
                row["iv_30d"] = v1
            else:
                w = (t2 - 30) / (t2 - t1)
                var = w * v1 ** 2 * t1 + (1 - w) * v2 ** 2 * t2
                row["iv_30d"] = float(np.sqrt(var / 30))
        else:
            row["iv_30d"] = min(pts, key=lambda p: abs(p[0] - 30))[1]

    # Skew on the first expiry at least a week out (expiry-week smiles are mostly noise).
    skew_exp = next((e for e in expiries if days[e] >= 7), None)
    if skew_exp is not None:
        e = by_exp[skew_exp]
        put25, call25 = delta_iv(e, -0.25), delta_iv(e, 0.25)
        a = atm[skew_exp]
        row |= {"skew_expiry": skew_exp, "skew_atm_iv": a, "iv_25d_put": put25, "iv_25d_call": call25,
                "rr_25d": put25 - call25, "bf_25d": (put25 + call25) / 2 - a}
    return row


# --- build and storage ----------------------------------------------------------------------

def greeks_dir() -> Path:
    return config.DATA_DIR / "derived" / "option_greeks"


def greeks_path(d: date) -> Path:
    return greeks_dir() / f"year={d.year}" / f"{d.isoformat()}.parquet"


def read_day(d: date) -> pd.DataFrame | None:
    p = greeks_path(d)
    return pd.read_parquet(p) if p.exists() else None


def check(iv: pd.DataFrame, fo_days: list[date], start: date | None = None,
          end: date | None = None) -> dict[str, pd.DataFrame]:
    """Quality checks on the IV summary. `fo_days`: days with an F&O file (each needs Greeks)."""
    days = [d for d in fo_days if (start is None or d >= start) and (end is None or d <= end)]
    if iv.empty:
        return {"iv_summary_missing": pd.DataFrame({"message": ["no iv_daily; run `niftyquant derive`"]})}
    iv = iv[iv["trade_date"].isin(days)]
    no_files = [d for d in days if not greeks_path(d).exists()]
    no_summary = sorted(set(days) - set(iv["trade_date"]))
    gap = iv["vix_close"] - iv["iv_30d"]
    return {
        "greeks_missing_days": pd.DataFrame({"trade_date": sorted(set(no_files) | set(no_summary))}),
        "iv_atm_missing": iv[iv["near_atm_iv"].isna() | iv["iv_30d"].isna()][["trade_date"]],
        # Normally VIX runs 0-4 points over 30-day ATM IV. Flag big gaps: a bad forward, stale
        # prices, or a real extreme (March 2020: ATM IV 10-14 points over VIX). Verify, may be real.
        "iv_30d_vs_vix_gap": iv[gap.abs() > np.maximum(6, 0.15 * iv["vix_close"])]
                             [["trade_date", "iv_30d", "vix_close"]],
        # Wings priced under ATM: not a real smile, usually stale prices on thin strikes.
        "iv_smile_implausible": iv[iv["bf_25d"] < -1][["trade_date", "skew_expiry", "iv_25d_put",
                                                       "skew_atm_iv", "iv_25d_call", "bf_25d"]],
    }
