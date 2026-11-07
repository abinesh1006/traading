"""FRED macro series (crude, rupee): download, parsing and session alignment (no network)."""

from datetime import date

import pandas as pd
import pytest

from niftyquant import macro

BRENT_CSV = (b"observation_date,DCOILBRENTEU\n"
             b"2026-10-29,118.00\n2026-10-30,120.15\n2026-11-02,107.39\n"
             b"2026-11-03,\n2026-11-04,.\n2026-11-05,106.00\n")
WTI_CSV = b"observation_date,DCOILWTICO\n2020-04-17,18.27\n2020-04-20,-36.98\n2020-04-21,8.91\n"
INR_CSV = b"observation_date,DEXINUS\n2026-10-29,95.2600\n2026-10-30,94.9400\n2026-11-02,\n"


def files():
    return {macro.FRED_CSV.format("DCOILBRENTEU"): BRENT_CSV,
            macro.FRED_CSV.format("DCOILWTICO"): WTI_CSV,
            macro.FRED_CSV.format("DEXINUS"): INR_CSV}


class FakeClient:
    def __init__(self, f):
        self.files = f

    def get(self, url):
        return self.files.get(url)


def test_parse_drops_blank_and_dot_and_keeps_negative():
    b = macro.parse_fred_csv(BRENT_CSV, "brent")
    assert list(b["obs_date"]) == [date(2026, 10, 29), date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 5)]
    assert macro.parse_fred_csv(WTI_CSV, "wti")["value"].min() == pytest.approx(-36.98)
    inr = macro.parse_fred_csv(INR_CSV, "usdinr")
    assert inr["unit"].unique().tolist() == ["inr_per_usd"] and len(inr) == 2


def test_parse_rejects_wrong_series():
    with pytest.raises(ValueError):
        macro.parse_fred_csv(WTI_CSV, "brent")


def test_fetch_writes_file_and_summary(tmp_path):
    s = macro.fetch(FakeClient(files()), root=tmp_path)
    assert s.loc["brent", "rows"] == 4 and s.loc["brent", "last_value"] == pytest.approx(106.0)
    assert s.loc["usdinr", "last_value"] == pytest.approx(94.94)
    assert s.loc["wti", "last"] == date(2020, 4, 21)
    assert len(macro.read(tmp_path)) == 9


def test_fetch_is_all_or_nothing(tmp_path):
    f = files()
    f.pop(macro.FRED_CSV.format("DEXINUS"))
    with pytest.raises(RuntimeError):
        macro.fetch(FakeClient(f), root=tmp_path)
    assert not macro.path(tmp_path).exists()


def test_align_uses_only_values_dated_before_the_session():
    df = macro.parse_fred_csv(BRENT_CSV, "brent")
    out = macro.align_to_sessions(df, [date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 6)],
                                  "brent")
    # Session 30 Oct sees 29 Oct, not its own date's price.
    assert out["source_date"].tolist() == [date(2026, 10, 29), date(2026, 10, 30), date(2026, 11, 2), date(2026, 11, 5)]
    assert out.loc[1, "ret_pct"] == pytest.approx((120.15 / 118.00 - 1) * 100)
    assert out.loc[2, "ret_pct"] == pytest.approx((107.39 / 120.15 - 1) * 100)


def test_check_flags_stale_missing_and_non_positive():
    df = pd.concat([macro.parse_fred_csv(c, s) for c, s in
                    [(BRENT_CSV, "brent"), (WTI_CSV, "wti"), (INR_CSV, "usdinr")]])
    res = macro.check(df, today=date(2026, 11, 7))
    assert res["macro_duplicates"].empty and res["macro_non_positive"].empty
    assert res["macro_series_absent"].empty
    assert res["macro_stale_series"]["series"].tolist() == ["wti"]  # WTI fixture ends in 2020
    assert macro.check(df[df["series"] != "usdinr"], today=date(2026, 11, 7))["macro_series_absent"]["series"].tolist() == ["usdinr"]
    bad = df.copy()
    bad.loc[bad["series"] == "usdinr", "value"] = 0.0
    assert len(macro.check(bad, today=date(2026, 11, 7))["macro_non_positive"]) == 2
    assert not macro.check(pd.DataFrame())["macro_missing"].empty
