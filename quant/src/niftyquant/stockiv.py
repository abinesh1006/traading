"""Daily implied volatility for the heavyweight stocks (stocks.UNIVERSE), from the stock F&O bhavcopy.

One row per (trade_date, symbol, expiry) for the first EXPIRIES_KEPT expiries:
- forward from put-call parity on traded strikes (else the future, else spot carried at the repo
  rate), the same method as the Nifty Greeks (greeks.forward_for_expiry).
- atm_iv: Black-76 IV at strike = forward, interpolated across liquid out-of-the-money strikes
  (greeks.atm_iv). NSE stock options are European, so Black-76 on the forward applies; dividends
  are inside the parity forward.
- atm_straddle: call + put close at the traded strike nearest the forward (both legs traded).

Used by results.py: the jump in near-expiry IV before results and its collapse after them give
the options-implied move and locate the session that reacted.
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ProcessPoolExecutor
from datetime import date

import numpy as np
import pandas as pd

from . import config, greeks, stocks
from .rates import repo_rate
from .store import day_path

log = logging.getLogger(__name__)

FILE = "stock_iv.parquet"
EXPIRIES_KEPT = 3
COLUMNS = ["trade_date", "symbol", "expiry", "days_to_expiry", "spot", "fut_close", "forward",
           "forward_source", "atm_iv", "atm_strike", "atm_straddle", "straddle_pct",
           "opt_volume_contracts", "opt_oi_units"]
PARALLEL_FROM = 40  # days; below this a process pool costs more than it saves
OPT_COLS = ["symbol", "expiry", "strike", "option_type", "close", "volume_contracts", "oi_units"]


def path():
    return config.DATA_DIR / "derived" / FILE


def day_iv(fo: pd.DataFrame, cm: pd.DataFrame, d: date) -> pd.DataFrame:
    """Per-symbol, per-expiry IV summary for one day. fo: stock F&O rows; cm: cash-market rows."""
    spots = cm[cm["series"] == "EQ"].drop_duplicates("symbol").set_index("symbol")["close"]
    # Only the columns needed: row selection on the full 23-column frame dominates the run time.
    opt = fo.loc[(fo["instrument"] == "OPT") & (fo["expiry"] > d), OPT_COLS]
    opt = opt.astype({"symbol": object, "option_type": object})
    if opt.empty:
        return pd.DataFrame(columns=COLUMNS)
    futs = fo[fo["instrument"] == "FUT"]
    fut = dict(zip(zip(futs["symbol"], futs["expiry"]), futs["close"]))
    r = repo_rate(d)

    parts = []
    for sym, rows in opt.groupby("symbol"):
        spot = float(spots.get(sym, np.nan))
        for expiry in sorted(rows["expiry"].unique())[:EXPIRIES_KEPT]:
            e = rows[rows["expiry"] == expiry].copy()
            T = (expiry - d).days / 365.0
            F, src = greeks.forward_for_expiry(e, T, r, spot, fut.get((sym, expiry)), spot)
            e["forward"], e["forward_source"], e["T"] = F, src, T
            parts.append(e)
    if not parts:
        return pd.DataFrame(columns=COLUMNS)
    o = pd.concat(parts, ignore_index=True)

    # One vectorized IV solve for the whole day.
    traded = (o["volume_contracts"] > 0) & (o["close"] > 0)
    price = o["close"].where(traded).to_numpy(dtype="float64")
    o["iv_pct"] = 100 * greeks.implied_vol(price, o["forward"].to_numpy(), o["strike"].to_numpy(),
                                           o["T"].to_numpy(), r, (o["option_type"] == "CE").to_numpy())

    out = []
    for (sym, expiry), e in o.groupby(["symbol", "expiry"], sort=True):
        F = float(e["forward"].iloc[0])
        tr = e[(e["volume_contracts"] > 0) & (e["close"] > 0)]
        both = pd.concat({"c": tr[tr["option_type"] == "CE"].set_index("strike")["close"],
                          "p": tr[tr["option_type"] == "PE"].set_index("strike")["close"]},
                         axis=1, join="inner")
        atm_k = straddle = np.nan
        if len(both) and np.isfinite(F):
            atm_k = float(both.index[np.argmin(np.abs(both.index.to_numpy(dtype="float64") - F))])
            straddle = float(both.loc[atm_k, "c"] + both.loc[atm_k, "p"])
        spot = float(spots.get(sym, np.nan))
        out.append({
            "trade_date": d, "symbol": sym, "expiry": expiry, "days_to_expiry": (expiry - d).days,
            "spot": spot, "fut_close": fut.get((sym, expiry), np.nan), "forward": F,
            "forward_source": e["forward_source"].iloc[0], "atm_iv": greeks.atm_iv(e),
            "atm_strike": atm_k, "atm_straddle": straddle,
            "straddle_pct": 100 * straddle / F if np.isfinite(F) and F > 0 else np.nan,
            "opt_volume_contracts": int(e["volume_contracts"].fillna(0).sum()),
            "opt_oi_units": int(e["oi_units"].fillna(0).sum()),
        })
    return pd.DataFrame(out, columns=COLUMNS)


def _day(d: date) -> pd.DataFrame:
    return day_iv(pd.read_parquet(day_path(stocks.FO_STOCK, d)), pd.read_parquet(day_path(stocks.CM, d)), d)


def _sessions_with_both() -> list[date]:
    return [d for d in stocks.sessions() if stocks.has_day(stocks.FO_STOCK, d) and stocks.has_day(stocks.CM, d)]


def build(full: bool = False) -> pd.DataFrame:
    """Incremental: days missing from the file, or whose source files are newer than it.
    Returns the full table; analytics.build_derived writes it."""
    p = path()
    old = pd.read_parquet(p) if p.exists() and not full else pd.DataFrame(columns=COLUMNS)
    built_at = p.stat().st_mtime if p.exists() and not full else 0.0
    have = set(old["trade_date"]) if not old.empty else set()
    todo = [d for d in _sessions_with_both()
            if d not in have or max(day_path(stocks.FO_STOCK, d).stat().st_mtime,
                                    day_path(stocks.CM, d).stat().st_mtime) > built_at]
    if not todo:
        return old
    log.info("stock IV: %d days to compute", len(todo))
    if len(todo) < PARALLEL_FROM:
        new = [_day(d) for d in todo]
    else:  # about 1.5 s per day in one process
        workers = max(1, min(6, (os.cpu_count() or 2) - 2))
        with ProcessPoolExecutor(workers) as pool:
            new = []
            for i, df in enumerate(pool.map(_day, todo, chunksize=20), 1):
                new.append(df)
                if i % 250 == 0:
                    log.info("stock IV: %d/%d", i, len(todo))
    fresh = pd.concat(new, ignore_index=True)
    keep = old[~old["trade_date"].isin(set(todo))] if not old.empty else old
    df = pd.concat([keep, fresh], ignore_index=True) if not keep.empty else fresh
    return df.sort_values(["trade_date", "symbol", "expiry"]).reset_index(drop=True)


def read() -> pd.DataFrame:
    p = path()
    return pd.read_parquet(p) if p.exists() else pd.DataFrame(columns=COLUMNS)
