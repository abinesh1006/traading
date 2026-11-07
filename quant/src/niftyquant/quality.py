"""Data quality checks over the curated NSE datasets.

Each check returns a DataFrame of offending rows; an empty frame means it passed.
"""

from datetime import date

import pandas as pd

from .store import Manifest, read_dataset

NIFTY_INDEX = "Nifty 50"


def check_calendar(manifest: Manifest, start: date | None, end: date | None) -> pd.DataFrame:
    """Trading days where some dataset is missing or errored."""
    m = manifest.frame()
    if m.empty:
        return m
    if start:
        m = m[m["trade_date"].dt.date >= start]
    if end:
        m = m[m["trade_date"].dt.date <= end]
    return m[m["status"].isin(["missing", "error"])].sort_values(["trade_date", "dataset"])


def check_fo(fo: pd.DataFrame, idx: pd.DataFrame) -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    key = ["trade_date", "symbol", "instrument", "expiry", "strike", "option_type"]
    out["duplicate_contracts"] = fo[fo.duplicated(key, keep=False)]

    traded = fo[fo["volume_contracts"] > 0]
    bad = (
        (traded["high"] < traded["low"])
        | (traded["open"] > traded["high"]) | (traded["open"] < traded["low"])
        | (traded["close"] > traded["high"] * 1.0001) | (traded["close"] < traded["low"] * 0.9999)
    )
    out["ohlc_inconsistent"] = traded[bad]
    out["negative_values"] = fo[(fo["volume_contracts"] < 0) | (fo["oi_units"] < 0)
                                | (fo[["open", "high", "low", "close"]] < 0).any(axis=1)]
    out["expiry_before_trade_date"] = fo[pd.to_datetime(fo["expiry"]) < pd.to_datetime(fo["trade_date"])]
    out["lot_size_missing"] = fo[fo["lot_size"].isna()]

    spot = idx[idx["index_name"] == NIFTY_INDEX][["trade_date", "close"]].rename(columns={"close": "spot"})
    fut = fo[(fo["instrument"] == "FUT") & (fo["symbol"] == "NIFTY")]
    near = fut.sort_values("expiry").groupby("trade_date", as_index=False).first()
    near = near.merge(spot, on="trade_date", how="left")
    near["basis_pct"] = (near["close"] / near["spot"] - 1) * 100
    out["near_future_basis_gt_3pct"] = near[near["basis_pct"].abs() > 3]
    out["no_spot_for_trade_date"] = near[near["spot"].isna()]

    und = fo[fo["underlying"].notna() & (fo["symbol"] == "NIFTY")]
    und = und.groupby("trade_date", as_index=False)["underlying"].first().merge(spot, on="trade_date")
    und["diff_pct"] = (und["underlying"] / und["spot"] - 1) * 100
    out["underlying_vs_index_gt_0_1pct"] = und[und["diff_pct"].abs() > 0.1]

    near = near.sort_values("trade_date")
    near["spot_ret_pct"] = near["spot"].pct_change() * 100
    out["spot_daily_move_gt_8pct"] = near[near["spot_ret_pct"].abs() > 8]
    return out


def check_participants(poi: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Every open contract has one long and one short, so TOTAL long should equal TOTAL short.

    NSE's file can be off by a contract or two (seen on 2018-01-05), so allow that.
    """
    if poi.empty:
        return {"participant_oi_long_ne_short": poi}
    tot = poi[poi["client_type"] == "TOTAL"]
    diff = (tot["total_long_contracts"] - tot["total_short_contracts"]).abs()
    return {"participant_oi_long_ne_short": tot[diff > 2]}


def run(start: date | None = None, end: date | None = None,
        manifest: Manifest | None = None) -> dict[str, pd.DataFrame]:
    manifest = manifest or Manifest()
    fo = read_dataset("fo_bhavcopy", start, end)
    idx = read_dataset("index_close", start, end)
    poi = read_dataset("participant_oi", start, end)
    results = {"calendar_gaps": check_calendar(manifest, start, end)}
    if not fo.empty:
        results |= check_fo(fo, idx)
    results |= check_participants(poi)
    from . import analytics, greeks  # IV and Greeks (derived; checks owned by greeks.py)
    fo_days = sorted(date.fromisoformat(p.stem) for p in analytics._fo_files())
    results |= greeks.check(analytics.load_derived(analytics.IV_DAILY), fo_days, start, end)
    from . import fiidii, macro, nsdl
    results |= macro.check(macro.read())
    sessions = idx["trade_date"].unique() if not idx.empty else None
    results |= nsdl.check(nsdl.read(), sessions)
    results |= fiidii.check(fiidii.read(start, end), sessions)
    return results
