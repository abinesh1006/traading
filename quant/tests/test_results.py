"""Stock IV summary and the quarterly-results study."""

from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from niftyquant import greeks, results, stockiv
from niftyquant.nse import parsers

FIX = Path(__file__).parent / "fixtures"
NOV6 = date(2026, 11, 6)


def test_stock_day_iv_on_real_files():
    fo = parsers.parse_fo_udiff((FIX / "fo_udiff_stock_20261106.csv.zip").read_bytes(), NOV6, ("RELIANCE",),
                                kind="stock")
    cm = parsers.parse_cm_udiff((FIX / "cm_udiff_20261106.csv.zip").read_bytes(), NOV6)
    df = stockiv.day_iv(fo, cm, NOV6)
    assert list(df.columns) == stockiv.COLUMNS
    near = df.sort_values("expiry").iloc[0]
    assert near["symbol"] == "RELIANCE" and near["spot"] == 1320.00
    assert near["forward_source"] == "parity" and abs(near["forward"] / near["spot"] - 1) < 0.01
    assert 10 < near["atm_iv"] < 60
    # The straddle and the IV describe the same option: straddle ~ 0.8 sigma sqrt(T) F.
    approx = 0.8 * near["atm_iv"] / 100 * np.sqrt(near["days_to_expiry"] / 365) * 100
    assert near["straddle_pct"] == pytest.approx(approx, rel=0.15)


def test_quarter_labels():
    assert results.quarter_label(date(2024, 6, 30)) == "Q1 FY25"
    assert results.quarter_label(date(2024, 12, 31)) == "Q3 FY25"
    assert results.quarter_label(date(2025, 3, 31)) == "Q4 FY25"


def _iv_row(d, e, iv, straddle=np.nan):
    return {"trade_date": d, "symbol": "TCS", "expiry": e, "days_to_expiry": (e - d).days, "atm_iv": iv,
            "straddle_pct": straddle}


def test_implied_event_move_recovers_event_variance():
    # Diffusive vol 20%, plus an event with one-day sd 4%: each expiry's IV carries the same E.
    d, react = date(2024, 7, 11), date(2024, 7, 12)
    e1, e2 = date(2024, 7, 25), date(2024, 8, 29)
    sd, E = 0.20, 0.04 ** 2
    ivs = [100 * np.sqrt(sd ** 2 + E / ((e - d).days / 365)) for e in (e1, e2)]
    pre = pd.DataFrame([_iv_row(d, e1, ivs[0], 5.0), _iv_row(d, e2, ivs[1])])
    move, straddle = results.implied_event_move(pre, react)
    assert move == pytest.approx(4.0, abs=1e-9) and straddle == 5.0
    # An expiry before the event cannot price it: with only one covering expiry there is no estimate.
    assert np.isnan(results.implied_event_move(pre, date(2024, 8, 1))[0])


def test_inferred_session_is_the_idiosyncratic_iv_drop():
    qe = date(2024, 6, 30)
    days = [qe + timedelta(days=i) for i in range(3, 70)]
    e = date(2024, 9, 26)
    rng = np.random.default_rng(0)
    stock = 25 + rng.normal(0, 0.2, len(days))
    market = 14 + rng.normal(0, 0.2, len(days))
    k_result = days.index(date(2024, 7, 12))
    k_market = days.index(date(2024, 8, 5))   # market-wide vol shock: both IVs fall together
    stock[:k_result] += 4                      # IV built up into the result, gone after it
    market[k_market:] -= 3
    stock[k_market:] -= 3
    iv = pd.DataFrame([_iv_row(d, e, v) for d, v in zip(days, stock)])
    drops = results.iv_drops(iv, pd.Series(market, index=days))
    cal = results.infer_calendar(drops, days[0], days[-1])
    row = cal[cal["quarter"] == "Q1 FY25"].iloc[0]
    assert row["reaction_session"] == date(2024, 7, 12) and row["detect_score"] > 5


def test_measure_returns_and_abnormal_move():
    sessions = pd.bdate_range("2023-01-02", periods=400).date
    rng = np.random.default_rng(1)
    nifty = rng.normal(0, 1, len(sessions))
    stock = 1.5 * nifty + rng.normal(0, 0.5, len(sessions))
    t = sessions[300]
    stock[300] = 1.5 * nifty[300] + 6.0     # result day: 6 points beyond what beta explains
    close = 100 * np.cumprod(1 + stock / 100)
    prev = np.r_[100, close[:-1]]
    rets = results.stock_returns(pd.DataFrame({
        "trade_date": sessions, "symbol": "TCS", "series": "EQ", "open": prev * 1.01, "close": close,
        "prev_close": prev, "volume_shares": 1000}))
    dm = pd.DataFrame({"trade_date": sessions, "spot_return_pct": nifty})
    cal = pd.DataFrame([{"symbol": "TCS", "quarter": "Q1 FY24", "quarter_end": date(2023, 6, 30),
                         "reaction_session": t, "source": "test"}])
    ev = results.measure(cal, rets, pd.DataFrame(columns=stockiv.COLUMNS), dm, pd.Series(dtype=float)).iloc[0]
    assert ev["pre_session"] == sessions[299]
    assert ev["return_pct"] == pytest.approx(stock[300])
    assert ev["gap_pct"] == pytest.approx(1.0)
    assert ev["beta"] == pytest.approx(1.5, abs=0.1)
    assert ev["abnormal_return_pct"] == pytest.approx(6.0, abs=0.3)
    assert ev["drift_3d_pct"] == pytest.approx((np.prod(1 + stock[301:304] / 100) - 1) * 100)


def test_atm_iv_reused_from_greeks():
    # stockiv relies on greeks.atm_iv reading these columns from its per-expiry frame.
    e = pd.DataFrame({"strike": [90.0, 100.0, 110.0, 90.0, 100.0, 110.0], "forward": 100.0,
                      "option_type": ["PE", "PE", "PE", "CE", "CE", "CE"], "iv_pct": [30, 25, 0, 0, 24, 22.0],
                      "volume_contracts": [100] * 6})
    assert greeks.atm_iv(e) == pytest.approx(24.0)
