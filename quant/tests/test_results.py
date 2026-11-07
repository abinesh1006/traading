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
    level = 20000 * np.cumprod(1 + nifty / 100)
    dm = pd.DataFrame({"trade_date": sessions, "spot_return_pct": nifty, "spot_close": level})
    cal = pd.DataFrame([{"symbol": "TCS", "quarter": "Q1 FY24", "quarter_end": date(2023, 6, 30),
                         "reaction_session": t, "source": "test"}])
    # A 5% weight at the pre-session close: the stock adds weight x return x level to the index.
    weights = pd.DataFrame({"trade_date": [sessions[299], t], "symbol": "TCS", "weight_pct": [5.0, 5.2],
                            "points": [0.0, 0.05 * stock[300] / 100 * level[299]]})
    ev = results.measure(cal, rets, pd.DataFrame(columns=stockiv.COLUMNS), dm, pd.Series(dtype=float),
                         weights).iloc[0]
    assert ev["pre_session"] == sessions[299]
    assert ev["return_pct"] == pytest.approx(stock[300])
    assert ev["gap_pct"] == pytest.approx(1.0)
    assert ev["beta"] == pytest.approx(1.5, abs=0.1)
    assert ev["abnormal_return_pct"] == pytest.approx(6.0, abs=0.3)
    assert ev["drift_3d_pct"] == pytest.approx((np.prod(1 + stock[301:304] / 100) - 1) * 100)
    assert ev["nifty_weight_pct"] == 5.0
    assert ev["nifty_move_points"] == pytest.approx(level[300] - level[299])
    assert ev["nifty_points"] == pytest.approx(0.05 * stock[300] / 100 * level[299])
    assert ev["nifty_abnormal_points"] == pytest.approx(0.05 * ev["abnormal_return_pct"] / 100 * level[299])
    assert ev["share_of_nifty_move_pct"] == pytest.approx(100 * ev["nifty_points"] / ev["nifty_move_points"])


def test_split_detected_but_crash_is_not():
    from niftyquant import stocks
    cm = pd.DataFrame({"trade_date": [date(2025, 8, 26), date(2020, 3, 23), date(2026, 1, 14), date(2024, 1, 17)],
                       "symbol": ["HDFCBANK", "AXISBANK", "KOTAKBANK", "HDFCBANK"],
                       "close": [973.40, 308.65, 421.00, 1536.90], "prev_close": [1964.10, 428.15, 2132.60, 1678.95]})
    market = pd.Series({date(2025, 8, 26): -0.1, date(2020, 3, 23): -12.98, date(2026, 1, 14): 0.2,
                        date(2024, 1, 17): -2.1})
    out = stocks.adjust(cm, market)
    # 1:1 bonus; Covid-crash day (a real -28% with the market -13%); 5-for-1 split; a real -8.5% day.
    assert out["ca_factor"].tolist() == [0.5, 1.0, 0.2, 1.0]
    assert out["adj_prev_close"].iloc[0] == pytest.approx(982.05)


def test_atm_iv_reused_from_greeks():
    # stockiv relies on greeks.atm_iv reading these columns from its per-expiry frame.
    e = pd.DataFrame({"strike": [90.0, 100.0, 110.0, 90.0, 100.0, 110.0], "forward": 100.0,
                      "option_type": ["PE", "PE", "PE", "CE", "CE", "CE"], "iv_pct": [30, 25, 0, 0, 24, 22.0],
                      "volume_contracts": [100] * 6})
    assert greeks.atm_iv(e) == pytest.approx(24.0)


def test_weight_fit_check_flags_poor_windows():
    from niftyquant import nifty_weights
    fits = pd.DataFrame({"window_start": [date(2024, 4, 1), date(2024, 10, 1), date(2025, 4, 1)],
                         "residual_sd_points": [1.3, 9.7, 0.8], "weight_sum_pct": [100.0, 99.8, 108.4]})
    bad = nifty_weights.check(fits)["nifty_weight_fit_poor"]
    assert bad["window_start"].tolist() == [date(2024, 10, 1), date(2025, 4, 1)]


def test_results_check_lists_dates_to_confirm_for_weak_stocks():
    rows = [("HDFCBANK", f"Q{i} FY24", "confirmed", date(2024, i, 10), date(2024, i, 20)) for i in (1, 2, 3)]
    rows += [("TCS", f"Q{i} FY24", "confirmed", date(2024, i, 12), date(2024, i, 12)) for i in (1, 2, 3)]
    rows += [("HDFCBANK", "Q4 FY24", "inferred", date(2024, 4, 22), date(2024, 4, 22)),
             ("TCS", "Q4 FY24", "inferred", date(2024, 4, 12), date(2024, 4, 12))]
    ev = pd.DataFrame(rows, columns=["symbol", "quarter", "source", "reaction_session", "inferred_session"])
    ev["detect_score"] = 4.0
    todo = results.check(ev)["result_dates_to_confirm"]
    assert todo[["symbol", "quarter"]].values.tolist() == [["HDFCBANK", "Q4 FY24"]]
