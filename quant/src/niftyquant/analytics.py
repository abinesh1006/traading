"""Derived daily views over the curated NSE data, for the API and dashboard.

`build_derived()` scans the per-day files once and writes small summary tables to
data/derived/. The API reads those, plus single-day files for the option chain.
"""

import logging
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from . import config, greeks
from .store import day_path

log = logging.getLogger(__name__)

NIFTY_INDEX = "Nifty 50"
VIX_INDEX = "India VIX"
DAILY_MARKET = "daily_market.parquet"
PARTICIPANTS = "participants_daily.parquet"
IV_DAILY = "iv_daily.parquet"
IV_ADDED = ("vix_close", "rv_20d")  # joined from daily_market on every build


def derived_dir() -> Path:
    return config.DATA_DIR / "derived"


def _fo_files() -> list[Path]:
    return sorted((config.CURATED_DIR / "nse" / "fo_bhavcopy").glob("year=*/*.parquet"))


def _index_row(d: date) -> dict:
    path = day_path("index_close", d)
    if not path.exists():
        return {}
    idx = pd.read_parquet(path).set_index("index_name")
    out = {}
    if NIFTY_INDEX in idx.index:
        r = idx.loc[NIFTY_INDEX]
        out |= {"spot_open": r["open"], "spot_high": r["high"], "spot_low": r["low"],
                "spot_close": r["close"], "nifty_pe": r["pe"]}
    if VIX_INDEX in idx.index:
        v = idx.loc[VIX_INDEX]
        out |= {"vix_open": v["open"], "vix_high": v["high"], "vix_low": v["low"], "vix_close": v["close"]}
    return out


def summarize_day(fo: pd.DataFrame, d: date, idx: dict) -> dict:
    """One row of daily market state from one day's Nifty F&O bhavcopy."""
    row: dict = {"trade_date": d, **idx}
    spot = idx.get("spot_close", np.nan)

    fut = fo[fo["instrument"] == "FUT"].sort_values("expiry")
    if len(fut):
        near = fut.iloc[0]
        row |= {"fut_close": near["close"], "fut_expiry": near["expiry"],
                "fut_oi_units": int(fut["oi_units"].sum()),
                "fut_volume_contracts": int(fut["volume_contracts"].sum()),
                "lot_size": int(near["lot_size"]) if pd.notna(near["lot_size"]) else None}
        if np.isfinite(spot) and spot > 0:
            row["basis_pct"] = (near["close"] / spot - 1) * 100

    opt = fo[fo["instrument"] == "OPT"]
    if len(opt):
        ce, pe = opt[opt["option_type"] == "CE"], opt[opt["option_type"] == "PE"]
        row |= {"opt_volume_contracts": int(opt["volume_contracts"].sum()),
                "ce_oi_units": int(ce["oi_units"].sum()), "pe_oi_units": int(pe["oi_units"].sum())}
        row["pcr_oi"] = row["pe_oi_units"] / row["ce_oi_units"] if row["ce_oi_units"] else np.nan

        expiry = opt["expiry"].min()
        n = opt[opt["expiry"] == expiry]
        nce, npe = n[n["option_type"] == "CE"], n[n["option_type"] == "PE"]
        row |= {"near_expiry": expiry, "days_to_expiry": (expiry - d).days,
                "near_ce_oi_units": int(nce["oi_units"].sum()),
                "near_pe_oi_units": int(npe["oi_units"].sum())}
        row["near_pcr_oi"] = (row["near_pe_oi_units"] / row["near_ce_oi_units"]
                              if row["near_ce_oi_units"] else np.nan)
        if len(nce) and nce["oi_units"].max() > 0:
            row["max_ce_oi_strike"] = float(nce.loc[nce["oi_units"].idxmax(), "strike"])
        if len(npe) and npe["oi_units"].max() > 0:
            row["max_pe_oi_strike"] = float(npe.loc[npe["oi_units"].idxmax(), "strike"])

        # ATM straddle on the nearest expiry: the market's priced move to expiry.
        if np.isfinite(spot) and spot > 0:
            both = nce.merge(npe, on="strike", suffixes=("_ce", "_pe"))
            both = both[(both["volume_contracts_ce"] > 0) & (both["volume_contracts_pe"] > 0)]
            if len(both):
                atm = both.iloc[(both["strike"] - spot).abs().argmin()]
                straddle = atm["close_ce"] + atm["close_pe"]
                row |= {"atm_strike": float(atm["strike"]), "atm_straddle": float(straddle),
                        "atm_straddle_pct": float(straddle / spot * 100)}
    return row


def build_daily_market(full: bool = False) -> pd.DataFrame:
    """Summarise each trading day. Incremental by default: only days not yet summarised
    (plus the last 5, in case late files changed them) are recomputed; full=True redoes all."""
    existing = pd.DataFrame() if full else load_derived(DAILY_MARKET)
    done: set[date] = set()
    if not existing.empty:
        keep = sorted(set(existing["trade_date"]))[:-5]
        existing = existing[existing["trade_date"].isin(keep)].drop(columns=["spot_return_pct"], errors="ignore")
        done = set(keep)
    rows = []
    for f in _fo_files():
        d = date.fromisoformat(f.stem)
        if d not in done:
            rows.append(summarize_day(pd.read_parquet(f), d, _index_row(d)))
    parts = [p for p in (existing, pd.DataFrame(rows)) if not p.empty]
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts, ignore_index=True).sort_values("trade_date").reset_index(drop=True)
    if "spot_close" in df:
        df["spot_return_pct"] = df["spot_close"].pct_change() * 100
    return df


def build_participants() -> pd.DataFrame:
    files = sorted((config.CURATED_DIR / "nse" / "participant_oi").glob("year=*/*.parquet"))
    if not files:
        return pd.DataFrame()
    p = pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)
    p = p[p["client_type"] != "TOTAL"]
    out = pd.DataFrame({
        "trade_date": p["trade_date"],
        "client_type": p["client_type"],
        "fut_index_long": p["future_index_long"],
        "fut_index_short": p["future_index_short"],
        "fut_index_net": p["future_index_long"] - p["future_index_short"],
        "opt_index_call_net": p["option_index_call_long"] - p["option_index_call_short"],
        "opt_index_put_net": p["option_index_put_long"] - p["option_index_put_short"],
    })
    total = out["fut_index_long"] + out["fut_index_short"]
    out["fut_index_long_pct"] = np.where(total > 0, out["fut_index_long"] / total * 100, np.nan)
    return out.sort_values(["trade_date", "client_type"]).reset_index(drop=True)


def build_iv(full: bool = False) -> pd.DataFrame:
    """Per-day IV/Greeks files for every option (derived/option_greeks/) and the daily volatility
    summary. Incremental: a day's Greeks are recomputed when its F&O file is newer than its Greeks
    file; a day missing from the summary is re-summarised from its existing Greeks file (so deleting
    iv_daily.parquet re-summarises everything in a minute or two, without recomputing Greeks)."""
    existing = pd.DataFrame() if full else load_derived(IV_DAILY)
    summarized = set(existing["trade_date"]) if not existing.empty else set()
    rows, redone = [], set()
    vol_cols = ["expiry", "strike", "option_type", "volume_contracts"]
    for f in _fo_files():
        d = date.fromisoformat(f.stem)
        out = greeks.greeks_path(d)
        fresh = out.exists() and out.stat().st_mtime >= f.stat().st_mtime
        if not full and fresh and d in summarized:
            continue
        fo = pd.read_parquet(f)
        if full or not fresh:
            g = greeks.day_greeks(fo, d, _index_row(d).get("spot_close"))
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".tmp")
            g.to_parquet(tmp, index=False, compression="zstd")
            tmp.replace(out)
        else:
            g = pd.read_parquet(out)
        # Volume rides along for the liquidity filter in the summary; it is not stored with the Greeks.
        opts = fo.loc[fo["instrument"] == "OPT", vol_cols]
        rows.append(greeks.summarize_iv(g.merge(opts, on=vol_cols[:3], how="left"), d))
        redone.add(d)
    if redone:
        log.info("IV and Greeks computed for %d days", len(redone))
    if not existing.empty:
        existing = existing[~existing["trade_date"].isin(redone)]
        existing = existing.drop(columns=[c for c in IV_ADDED if c in existing], errors="ignore")
    parts = [p for p in (existing, pd.DataFrame(rows)) if not p.empty]
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts, ignore_index=True).sort_values("trade_date").reset_index(drop=True)

    # Realised volatility and VIX alongside, for implied-vs-realised comparisons.
    dm = load_derived(DAILY_MARKET)
    if not dm.empty:
        px = dm[["trade_date", "spot_close", "vix_close"]].sort_values("trade_date")
        ret = np.log(px["spot_close"]).diff()
        px["rv_20d"] = ret.rolling(20, min_periods=15).std() * np.sqrt(252) * 100
        df = df.merge(px[["trade_date", "vix_close", "rv_20d"]], on="trade_date", how="left")
    return df


def build_derived(full: bool = False) -> dict[str, int]:
    out_dir = derived_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    builders = ((DAILY_MARKET, lambda: build_daily_market(full)), (PARTICIPANTS, build_participants),
                (IV_DAILY, lambda: build_iv(full)))
    from . import events  # reads daily_market and iv_daily written just above
    builders += ((events.FILE, events.build), (events.IMPACT_FILE, lambda: events.category_impact(events.build())))
    from . import premiums  # needs the option_greeks files written by build_iv
    builders += ((premiums.FILE, lambda: premiums.build(full)),)
    for name, builder in builders:
        df = builder()
        tmp = out_dir / (name + ".tmp")
        df.to_parquet(tmp, index=False)
        tmp.replace(out_dir / name)
        result[name] = len(df)
        log.info("wrote %s (%d rows)", name, len(df))
    return result


def load_derived(name: str) -> pd.DataFrame:
    path = derived_dir() / name
    return pd.read_parquet(path) if path.exists() else pd.DataFrame()


def eod_chain(d: date, expiry: date | None = None) -> dict | None:
    """End-of-day option chain for one date: one row per strike, CE and PE side by side."""
    path = day_path("fo_bhavcopy", d)
    if not path.exists():
        return None
    fo = pd.read_parquet(path)
    opt = fo[fo["instrument"] == "OPT"]
    expiries = sorted(opt["expiry"].unique())
    if not expiries:
        return None
    expiry = expiry or expiries[0]
    if expiry not in expiries:
        raise ValueError(f"expiry {expiry} not listed on {d}; available: {expiries}")
    sel = opt[opt["expiry"] == expiry]
    cols = ["strike", "close", "last", "settle", "oi_units", "oi_change_units",
            "volume_contracts", "turnover_inr"]
    ce = sel[sel["option_type"] == "CE"][cols].set_index("strike").add_prefix("ce_")
    pe = sel[sel["option_type"] == "PE"][cols].set_index("strike").add_prefix("pe_")
    chain = ce.join(pe, how="outer").sort_index()
    forward = None
    g = greeks.read_day(d)
    if g is not None and not g.empty:
        ge = g[g["expiry"] == expiry]
        if len(ge):
            forward = float(ge["forward"].iloc[0])
            gcols = ["strike", "iv_pct", "delta", "gamma", "theta", "vega"]
            for side in ("CE", "PE"):
                part = ge[ge["option_type"] == side][gcols].set_index("strike").add_prefix(f"{side.lower()}_")
                chain = chain.join(part, how="left")
    chain = chain.reset_index()
    idx = _index_row(d)
    lot = sel["lot_size"].dropna()
    return {
        "trade_date": d, "expiry": expiry, "expiries": expiries,
        "spot_close": idx.get("spot_close"), "vix_close": idx.get("vix_close"),
        "forward": forward,
        "lot_size": int(lot.iloc[0]) if len(lot) else None,
        "rows": chain,
    }
