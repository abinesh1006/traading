"""Option premium by moneyness: what an ITM / ATM / OTM Nifty option cost at a given spot.

For each trading day and the nearest expiry, every strike within MAX_STEPS strike steps of the
at-the-money strike, calls and puts:
- steps_itm: +n = n steps in the money, 0 = ATM, -n = n steps out of the money.
  A step is STEP points (50 for Nifty). CE is ITM below spot, PE above.
- premium: NSE closing price. intrinsic: value if exercised at today's spot close.
  time_value = premium - intrinsic (what you pay for time and volatility; it decays to 0 at expiry).
- iv_pct, delta from derived/option_greeks (Black-76 on the forward), when available.
- next_premium / next_spot: the same contract at the next session's close, to measure what
  buying at the close and holding one session would have done.

End-of-day only: this is the 15:30/15:40 close, not "the premium at 10:15". Intraday premiums
need minute-level option history (planned: Fyers).
"""

import logging
from datetime import date

import numpy as np
import pandas as pd

from . import analytics, config, greeks
from .store import day_path

log = logging.getLogger(__name__)

STEP = 50.0
MAX_STEPS = 10
FILE = "moneyness_daily.parquet"
COLUMNS = ["trade_date", "expiry", "days_to_expiry", "spot", "atm_strike", "option_type", "strike",
           "steps_itm", "premium", "intrinsic", "time_value", "volume_contracts", "oi_units",
           "iv_pct", "delta", "lot_size", "vix_close", "next_date", "next_premium", "next_spot"]


def ladder(fo: pd.DataFrame, d: date, spot: float, g: pd.DataFrame | None = None,
           max_steps: int = MAX_STEPS, expiry: date | None = None) -> pd.DataFrame:
    """Strikes around ATM for one day and expiry (default: the nearest expiry, which is d itself
    on an expiry day; filter on days_to_expiry when that matters)."""
    opt = fo[(fo["instrument"] == "OPT") & (fo["expiry"] >= d)]
    if opt.empty or not np.isfinite(spot):
        return pd.DataFrame(columns=COLUMNS)
    expiry = expiry or opt["expiry"].min()
    e = opt[opt["expiry"] == expiry].copy()
    atm = round(spot / STEP) * STEP
    e["steps_from_atm"] = (e["strike"] - atm) / STEP
    e = e[(e["steps_from_atm"].abs() <= max_steps) & (e["steps_from_atm"] == e["steps_from_atm"].round())]
    e["steps_itm"] = np.where(e["option_type"] == "CE", -e["steps_from_atm"], e["steps_from_atm"]).astype(int)
    e["intrinsic"] = np.where(e["option_type"] == "CE", np.maximum(spot - e["strike"], 0),
                              np.maximum(e["strike"] - spot, 0))
    # Untraded strikes carry an exchange-computed close, not a price anyone paid.
    e["premium"] = e["close"].where(e["volume_contracts"] > 0)
    e["time_value"] = e["premium"] - e["intrinsic"]
    e = e.assign(trade_date=d, days_to_expiry=(expiry - d).days, spot=spot, atm_strike=atm)
    if g is not None and not g.empty:
        e = e.merge(g[["expiry", "strike", "option_type", "iv_pct", "delta"]],
                    on=["expiry", "strike", "option_type"], how="left")
    else:
        e["iv_pct"] = e["delta"] = np.nan
    for c in ("vix_close", "next_date", "next_premium", "next_spot"):
        e[c] = np.nan
    return e.reindex(columns=COLUMNS).sort_values(["option_type", "steps_itm"]).reset_index(drop=True)


def _day(d: date) -> tuple[pd.DataFrame, dict]:
    idx = analytics._index_row(d)
    fo = pd.read_parquet(day_path("fo_bhavcopy", d))
    lad = ladder(fo, d, idx.get("spot_close", np.nan), greeks.read_day(d))
    lad["vix_close"] = idx.get("vix_close", np.nan)
    # Same contracts' closes today, for filling the previous day's next_premium.
    o = fo[fo["instrument"] == "OPT"]
    closes = o.assign(px=o["close"].where(o["volume_contracts"] > 0))[["expiry", "strike", "option_type", "px"]]
    return lad, {"closes": closes, "spot": idx.get("spot_close", np.nan)}


def build(full: bool = False) -> pd.DataFrame:
    """Incremental by default: days before the last 5 already built are kept as they are."""
    files = sorted((config.CURATED_DIR / "nse" / "fo_bhavcopy").glob("year=*/*.parquet"))
    existing = pd.DataFrame() if full else load()
    out, prev = [], None
    if not existing.empty:
        days = sorted(existing["trade_date"].unique())
        keep_before = days[-5] if len(days) > 5 else days[0]
        existing = existing[existing["trade_date"] < keep_before]
        if not existing.empty:
            out.append(existing)
            # Kept days already have next_premium; rebuild from the day after the last kept one.
            first = existing["trade_date"].max()
            files = [f for f in files if date.fromisoformat(f.stem) > first]
    for f in files:
        d = date.fromisoformat(f.stem)
        lad, today = _day(d)
        if prev is not None and not prev.empty:
            m = prev.drop(columns=["next_premium"]).merge(
                today["closes"].rename(columns={"px": "next_premium"}),
                on=["expiry", "strike", "option_type"], how="left")
            m["next_date"], m["next_spot"] = d, today["spot"]
            out.append(m[COLUMNS])
        prev = lad
    if prev is not None and not prev.empty:
        out.append(prev)  # last day: next session not known yet
    if not out:
        return pd.DataFrame(columns=COLUMNS)
    df = pd.concat(out, ignore_index=True)
    df["next_date"] = pd.to_datetime(df["next_date"]).dt.date
    return df


def write(df: pd.DataFrame) -> None:
    p = analytics.derived_dir() / FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    df.to_parquet(tmp, index=False, compression="zstd")
    tmp.replace(p)


def load() -> pd.DataFrame:
    return analytics.load_derived(FILE)


def show(d: date, steps: int = 5, expiry: date | None = None) -> pd.DataFrame:
    """Calls and puts side by side around ATM for one day, ITM to OTM."""
    idx = analytics._index_row(d)
    p = day_path("fo_bhavcopy", d)
    if not p.exists():
        raise FileNotFoundError(f"no F&O bhavcopy for {d}")
    lad = ladder(pd.read_parquet(p), d, idx.get("spot_close", np.nan), greeks.read_day(d), steps, expiry)
    cols = ["strike", "steps_itm", "premium", "intrinsic", "time_value", "iv_pct", "delta", "volume_contracts"]
    ce = lad[lad["option_type"] == "CE"][cols].add_prefix("ce_").rename(columns={"ce_strike": "strike"})
    pe = lad[lad["option_type"] == "PE"][cols].add_prefix("pe_").rename(columns={"pe_strike": "strike"})
    t = ce.merge(pe, on="strike", how="outer").sort_values("strike").reset_index(drop=True)
    t.attrs |= {"spot": idx.get("spot_close"), "vix": idx.get("vix_close"),
                "expiry": lad["expiry"].iloc[0] if len(lad) else None,
                "days_to_expiry": lad["days_to_expiry"].iloc[0] if len(lad) else None}
    return t
