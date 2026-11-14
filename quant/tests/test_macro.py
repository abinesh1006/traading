"""FRED daily series (world markets, crude, rupee): download, merge, parsing, alignment (no network)."""

from datetime import date

import pandas as pd
import pytest

from niftyquant import macro

BRENT_CSV = (b"observation_date,DCOILBRENTEU\n"
             b"2026-10-29,118.00\n2026-10-30,120.15\n2026-11-02,107.39\n"
             b"2026-11-03,\n2026-11-04,.\n2026-11-05,106.00\n")
WTI_CSV = b"observation_date,DCOILWTICO\n2020-04-17,18.27\n2020-04-20,-36.98\n2020-04-21,8.91\n"
INR_CSV = b"observation_date,DEXINUS\n2026-10-29,95.2600\n2026-10-30,94.9400\n2026-11-02,\n"
SPECIAL = {"brent": BRENT_CSV, "wti": WTI_CSV, "usdinr": INR_CSV}


def csv_for(series: str) -> bytes:
    if series in SPECIAL:
        return SPECIAL[series]
    fred_id = macro.SERIES[series][0]
    return f"observation_date,{fred_id}\n2026-11-04,100.0\n2026-11-05,101.5\n".encode()


def files():
    return {macro.FRED_CSV.format(fred_id): csv_for(s) for s, (fred_id, _) in macro.SERIES.items()}


class FakeClient:
    def __init__(self, f):
        self.files = f

    def get(self, url):
        return self.files.get(url)


def all_series_frame():
    return pd.concat([macro.parse_fred_csv(csv_for(s), s) for s in macro.SERIES], ignore_index=True)


def test_parse_drops_blank_and_dot_and_keeps_negative():
    b = macro.parse_fred_csv(BRENT_CSV, "brent")
    assert list(b["obs_date"]) == [date(2026, 10, 29), date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 5)]
    assert macro.parse_fred_csv(WTI_CSV, "wti")["value"].min() == pytest.approx(-36.98)
    inr = macro.parse_fred_csv(INR_CSV, "usdinr")
    assert inr["unit"].unique().tolist() == ["inr_per_usd"] and len(inr) == 2
    assert macro.parse_fred_csv(csv_for("us_10y"), "us_10y")["unit"].iloc[0] == "percent_a_year"


def test_parse_rejects_wrong_series():
    with pytest.raises(ValueError):
        macro.parse_fred_csv(WTI_CSV, "brent")


def test_fetch_writes_file_and_summary(tmp_path):
    s = macro.fetch(FakeClient(files()), root=tmp_path)
    assert set(s.index) == set(macro.SERIES)
    assert s.loc["brent", "rows"] == 4 and s.loc["brent", "last_value"] == pytest.approx(106.0)
    assert s.loc["usdinr", "last_value"] == pytest.approx(94.94)
    assert s.loc["sp500", "last_value"] == pytest.approx(101.5)
    assert s.loc["wti", "last"] == date(2020, 4, 21)
    assert len(macro.read(tmp_path)) == 9 + 2 * (len(macro.SERIES) - 3)


def test_fetch_is_all_or_nothing(tmp_path):
    f = files()
    f.pop(macro.FRED_CSV.format("DEXINUS"))
    with pytest.raises(RuntimeError):
        macro.fetch(FakeClient(f), root=tmp_path)
    assert not macro.path(tmp_path).exists()


def test_fetch_keeps_history_the_source_dropped_and_takes_revisions(tmp_path):
    macro.fetch(FakeClient(files()), root=tmp_path)
    # Next day FRED's S&P 500 window has moved: 2026-11-04 is gone, 2026-11-05 revised, 2026-11-06 new.
    f = files()
    f[macro.FRED_CSV.format("SP500")] = b"observation_date,SP500\n2026-11-05,102.0\n2026-11-06,103.0\n"
    macro.fetch(FakeClient(f), root=tmp_path)
    sp = macro.read(tmp_path).query("series == 'sp500'").set_index("obs_date")["value"]
    assert sp.to_dict() == {date(2026, 11, 4): 100.0, date(2026, 11, 5): 102.0, date(2026, 11, 6): 103.0}


def test_merge_drops_series_no_longer_configured():
    new = macro.parse_fred_csv(BRENT_CSV, "brent")
    old = pd.DataFrame({"obs_date": [date(2000, 1, 3)], "series": ["gold"], "value": [280.0],
                        "unit": ["usd_per_ounce"], "fred_id": ["GOLD"]})
    assert set(macro.merge(new, old)["series"]) == {"brent"}


def test_align_uses_only_values_dated_before_the_session():
    df = macro.parse_fred_csv(BRENT_CSV, "brent")
    out = macro.align_to_sessions(df, [date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 6)],
                                  "brent")
    # Session 30 Oct sees 29 Oct, not its own date's price.
    assert out["source_date"].tolist() == [date(2026, 10, 29), date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 5)]
    assert out.loc[1, "ret_pct"] == pytest.approx((120.15 / 118.00 - 1) * 100)
    assert out.loc[2, "ret_pct"] == pytest.approx((107.39 / 120.15 - 1) * 100)


def test_check_flags_stale_missing_and_non_positive():
    df = all_series_frame()
    res = macro.check(df, today=date(2026, 11, 7))
    assert res["macro_duplicates"].empty and res["macro_non_positive"].empty
    assert res["macro_series_absent"].empty
    assert res["macro_stale_series"]["series"].tolist() == ["wti"]  # WTI fixture ends in 2020
    absent = macro.check(df[df["series"] != "usdinr"], today=date(2026, 11, 7))["macro_series_absent"]
    assert absent["series"].tolist() == ["usdinr"]
    bad = df.copy()
    bad.loc[bad["series"] == "usdinr", "value"] = 0.0
    assert len(macro.check(bad, today=date(2026, 11, 7))["macro_non_positive"]) == 2
    assert not macro.check(pd.DataFrame())["macro_missing"].empty
