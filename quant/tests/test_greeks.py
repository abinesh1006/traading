"""Black-76 IV and Greeks: round trips, bounds, finite-difference checks, and a real NSE day."""

from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from niftyquant import greeks, rates
from niftyquant.nse import parsers

FIX = Path(__file__).parent / "fixtures"
R = 0.055


def test_iv_round_trip_across_moneyness_and_maturity():
    F = np.full(6, 25000.0)
    K = np.array([22000, 24000, 25000, 25000, 26000, 28000.0])
    T = np.array([2, 7, 7, 30, 30, 90]) / 365
    is_call = np.array([False, False, True, False, True, True])
    sigma = np.array([0.35, 0.20, 0.15, 0.15, 0.13, 0.16])
    price = greeks.black76(F, K, T, R, sigma, is_call)
    assert np.allclose(greeks.implied_vol(price, F, K, T, R, is_call), sigma, atol=1e-6)


def test_iv_is_nan_outside_no_arbitrage_bounds_and_on_expiry():
    F, K, T = np.array([25000.0] * 3), np.array([24000.0, 26000.0, 25000.0]), np.array([7, 7, 0]) / 365
    is_call = np.array([True, True, True])
    price = np.array([900.0, 25001.0, 50.0])  # below intrinsic; above the forward; T = 0
    assert np.isnan(greeks.implied_vol(price, F, K, T, R, is_call)).all()


def test_greeks_match_finite_differences():
    F, K, T, s = 25000.0, 25200.0, 10 / 365, 0.16
    for is_call in (True, False):
        g = greeks.greeks(F, K, T, R, s, is_call)
        v = lambda f=F, t=T, vol=s: float(greeks.black76(f, K, t, R, vol, is_call))
        h = 1.0
        assert g["delta"] == pytest.approx((v(F + h) - v(F - h)) / (2 * h), rel=1e-4)
        assert g["gamma"] == pytest.approx((v(F + h) - 2 * v() + v(F - h)) / h ** 2, rel=1e-3)
        assert g["vega"] == pytest.approx((v(vol=s + 1e-4) - v(vol=s - 1e-4)) / 2e-4 / 100, rel=1e-4)
        eps = 1e-6  # theta is the instantaneous decay rate, per calendar day
        assert g["theta"] == pytest.approx((v(t=T - eps) - v(t=T + eps)) / (2 * eps) / 365, rel=1e-4)


def test_put_call_parity_and_delta_relation():
    F, K, T, s = 25000.0, 24800.0, 20 / 365, 0.14
    c = float(greeks.black76(F, K, T, R, s, True))
    p = float(greeks.black76(F, K, T, R, s, False))
    assert c - p == pytest.approx(np.exp(-R * T) * (F - K))
    dc = greeks.greeks(F, K, T, R, s, True)["delta"]
    dp = greeks.greeks(F, K, T, R, s, False)["delta"]
    assert dc - dp == pytest.approx(np.exp(-R * T))


def test_repo_rate_steps():
    assert rates.repo_rate(date(2020, 3, 26)) == pytest.approx(0.0515)
    assert rates.repo_rate(date(2020, 3, 27)) == pytest.approx(0.044)
    assert rates.repo_rate(date(2026, 11, 6)) == pytest.approx(0.055)


@pytest.fixture(scope="module")
def nov6():
    d = date(2026, 11, 6)
    fo = parsers.parse_fo_udiff((FIX / "fo_udiff_20261106.csv.zip").read_bytes(), d, ("NIFTY",))
    return d, fo, greeks.day_greeks(fo, d, 25030.35)


def test_real_day_forward_and_iv(nov6):
    d, fo, g = nov6
    assert (g["expiry"] > d).all() and (g["days_to_expiry"] > 0).all()
    ok = g.dropna(subset=["iv_pct"])
    assert len(ok) > 0 and ok["iv_pct"].between(3, 150).all()
    traded = fo[(fo["instrument"] == "OPT") & (fo["volume_contracts"] > 0)]
    # Untraded options never get an IV.
    untraded = g.merge(traded[["expiry", "strike", "option_type"]], how="left", indicator=True)
    assert untraded.loc[untraded["_merge"] == "left_only", "iv_pct"].isna().all()
    # Parity forward is within 0.5% of spot for the near expiry.
    assert abs(g["forward"].iloc[0] / 25030.35 - 1) < 0.005


def test_summary_has_atm_iv(nov6):
    d, _, g = nov6
    s = greeks.summarize_iv(g, d)
    assert s["near_expiry"] == date(2026, 11, 9)
    assert 5 < s["near_atm_iv"] < 60


def test_liquid_mask_drops_stale_thin_strikes():
    e = pd.DataFrame({"option_type": ["PE"] * 4 + ["CE"] * 2,
                      "volume_contracts": [80000, 5, 344, 12261, 40000, 9]})
    assert greeks.liquid_mask(e).tolist() == [True, False, False, True, True, False]


def test_summary_ignores_illiquid_wing(nov6):
    d, fo, g = nov6
    vols = fo.loc[fo["instrument"] == "OPT", ["expiry", "strike", "option_type", "volume_contracts"]]
    gv = g.merge(vols, on=["expiry", "strike", "option_type"], how="left")
    e = gv[gv["expiry"] == date(2026, 11, 9)]
    thin_traded = e[e["iv_pct"].notna() & ~greeks.liquid_mask(e)]
    assert len(thin_traded) > 0  # the fixture has thin strikes with an IV, so the filter matters
    curve = greeks._otm_curve(e)
    assert not set(curve.index) & set(thin_traded.index)
    # Corrupting the thin strikes' IV leaves ATM IV unchanged.
    bad = gv.assign(iv_pct=gv["iv_pct"].mask(gv.index.isin(thin_traded.index), 1.0))
    assert greeks.summarize_iv(bad, d)["near_atm_iv"] == pytest.approx(greeks.summarize_iv(gv, d)["near_atm_iv"])


def test_quality_checks_flag_gaps_and_bad_smiles(tmp_path, monkeypatch):
    from niftyquant import config
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    d1, d2, d3 = date(2026, 11, 4), date(2026, 11, 5), date(2026, 11, 6)
    for d in (d1, d2):
        greeks.greeks_path(d).parent.mkdir(parents=True, exist_ok=True)
        greeks.greeks_path(d).write_bytes(b"")
    iv = pd.DataFrame({"trade_date": [d1, d2], "near_atm_iv": [15.0, 16.0], "iv_30d": [14.0, 30.0],
                       "vix_close": [15.5, 17.0], "skew_expiry": [d3, d3], "iv_25d_put": [16.0, 13.0],
                       "skew_atm_iv": [14.0, 16.0], "iv_25d_call": [13.5, 12.0], "bf_25d": [0.75, -3.5]})
    r = greeks.check(iv, [d1, d2, d3])
    assert r["greeks_missing_days"]["trade_date"].tolist() == [d3]
    assert r["iv_atm_missing"].empty
    assert r["iv_30d_vs_vix_gap"]["trade_date"].tolist() == [d2]
    assert r["iv_smile_implausible"]["trade_date"].tolist() == [d2]
