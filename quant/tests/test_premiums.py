"""Premium-by-moneyness ladder and the next-session join (no network, synthetic chain)."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from niftyquant import analytics, premiums
from niftyquant.store import write_day

D1, D2 = date(2026, 11, 5), date(2026, 11, 6)
EXP = date(2026, 11, 9)


def chain(d, spot, vol=10):
    rows = []
    for k in np.arange(24700, 25301, 50.0):
        for t in ("CE", "PE"):
            intrinsic = max(spot - k, 0) if t == "CE" else max(k - spot, 0)
            rows.append({"trade_date": d, "symbol": "NIFTY", "instrument": "OPT", "expiry": EXP, "strike": k,
                         "option_type": t, "close": intrinsic + 40.0, "volume_contracts": vol, "oi_units": 1000})
    rows.append({"trade_date": d, "symbol": "NIFTY", "instrument": "FUT", "expiry": EXP, "strike": np.nan,
                 "option_type": None, "close": spot + 5, "volume_contracts": 5, "oi_units": 1000})
    return pd.DataFrame(rows)


def test_ladder_moneyness_and_time_value():
    lad = premiums.ladder(chain(D1, 25010.0), D1, 25010.0, max_steps=2)
    assert lad["atm_strike"].iloc[0] == 25000
    ce = lad[lad["option_type"] == "CE"].set_index("strike")
    pe = lad[lad["option_type"] == "PE"].set_index("strike")
    # A call below spot is in the money; a put above spot is in the money.
    assert ce.loc[24900, "steps_itm"] == 2 and ce.loc[25100, "steps_itm"] == -2
    assert pe.loc[25100, "steps_itm"] == 2 and pe.loc[24900, "steps_itm"] == -2
    assert ce.loc[24900, "intrinsic"] == pytest.approx(110) and ce.loc[24900, "time_value"] == pytest.approx(40)
    assert len(lad) == 10  # 5 strikes x CE/PE


def test_untraded_strike_has_no_premium():
    fo = chain(D1, 25000.0)
    fo.loc[(fo["strike"] == 25050) & (fo["option_type"] == "CE"), "volume_contracts"] = 0
    lad = premiums.ladder(fo, D1, 25000.0, max_steps=1)
    row = lad[(lad["strike"] == 25050) & (lad["option_type"] == "CE")].iloc[0]
    assert np.isnan(row["premium"]) and np.isnan(row["time_value"])


@pytest.fixture
def two_days(tmp_path, monkeypatch):
    from niftyquant import config
    monkeypatch.setattr(config, "CURATED_DIR", tmp_path / "curated")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    for d, spot in ((D1, 25000.0), (D2, 25100.0)):
        write_day(chain(d, spot), "fo_bhavcopy", d)
        write_day(pd.DataFrame([{"index_name": "Nifty 50", "trade_date": d, "open": spot, "high": spot,
                                 "low": spot, "close": spot, "pe": 22.0},
                                {"index_name": "India VIX", "trade_date": d, "open": 15, "high": 16,
                                 "low": 14, "close": 15.5, "pe": np.nan}]), "index_close", d)


def test_build_fills_next_session(two_days):
    df = premiums.build(full=True)
    first = df[(df["trade_date"] == D1) & (df["option_type"] == "CE") & (df["strike"] == 25000)].iloc[0]
    assert first["next_date"] == D2 and first["next_spot"] == 25100
    assert first["premium"] == pytest.approx(40) and first["next_premium"] == pytest.approx(140)
    assert first["vix_close"] == 15.5
    assert df[df["trade_date"] == D2]["next_premium"].isna().all()

    premiums.write(df)
    again = premiums.build()  # incremental path gives the same table
    pd.testing.assert_frame_equal(again.reset_index(drop=True), df.reset_index(drop=True), check_dtype=False)


def test_show_side_by_side(two_days):
    t = premiums.show(D2, steps=2)
    assert t.attrs["spot"] == 25100 and t.attrs["days_to_expiry"] == 3
    row = t[t["strike"] == 25000].iloc[0]
    assert row["ce_steps_itm"] == 2 and row["pe_steps_itm"] == -2
    assert analytics.derived_dir().name == "derived"
