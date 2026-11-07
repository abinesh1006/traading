"""NSDL FPI daily flows: parsing real archive pages and the resumable monthly download (no network)."""

from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from niftyquant import nsdl

FIX = Path(__file__).parent / "fixtures"


def page(name):
    return (FIX / name).read_bytes()


def test_parse_2015_page():
    df = nsdl.parse_archive(page("nsdl_fpi_20150115.html"), date(2015, 1, 15))
    first = df.iloc[0]
    assert first["reporting_date"] == date(2015, 1, 1)
    assert (first["exch_buy_cr"], first["exch_sell_cr"], first["exch_net_cr"]) == (2337.70, 1861.75, 475.95)
    assert first["primary_net_cr"] == 79.09 and first["equity_net_cr"] == 555.04
    assert first["usd_inr"] == pytest.approx(63.3315)
    assert df["reporting_date"].max() <= date(2015, 1, 15)
    assert df["reporting_date"].is_unique


def test_parse_2026_page_with_many_asset_classes():
    df = nsdl.parse_archive(page("nsdl_fpi_20261105.html"), date(2026, 11, 5))
    first = df.iloc[0]
    assert first["reporting_date"] == date(2026, 11, 2)
    assert (first["exch_net_cr"], first["primary_net_cr"], first["equity_net_cr"]) == (4318.90, 138.90, 4457.80)
    assert first["usd_inr"] == pytest.approx(95.2492)
    # Debt, hybrid, MF and AIF rows are ignored, and every day has all equity fields.
    assert not df.isna().any().any()


def test_parse_rejects_page_for_other_date():
    with pytest.raises(nsdl.ParseError):
        nsdl.parse_archive(page("nsdl_fpi_20261105.html"), date(2026, 11, 6))


def test_hidden_fields_from_form():
    f = nsdl.hidden_fields(page("nsdl_archive_form.html").decode())
    assert {"__VIEWSTATE", "__EVENTVALIDATION"} <= set(f)


class FakeClient:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def month_until(self, d):
        self.calls.append(d)
        if d not in self.pages:
            raise RuntimeError("no page")
        return self.pages[d]


def test_fetch_skips_final_months_and_refreshes_recent(tmp_path):
    pages = {date(2015, 1, 31): page("nsdl_fpi_20150115.html").replace(b"15-Jan-2015", b"31-Jan-2015")}
    c = FakeClient(pages)
    log = nsdl.fetch(date(2015, 1, 1), date(2015, 2, 10), client=c, root=tmp_path, today=date(2026, 11, 7))
    assert log["result"].tolist() == ["ok", "error"]  # February page missing -> retried next run
    assert len(nsdl.read(tmp_path)) > 0

    c2 = FakeClient(pages)
    log2 = nsdl.fetch(date(2015, 1, 1), date(2015, 1, 31), client=c2, root=tmp_path, today=date(2026, 11, 7))
    assert log2["result"].tolist() == ["skip"] and c2.calls == []

    # The current month is always re-downloaded, up to today.
    c3 = FakeClient({date(2026, 11, 5): page("nsdl_fpi_20261105.html")})
    log3 = nsdl.fetch(date(2026, 11, 1), client=c3, root=tmp_path, today=date(2026, 11, 5))
    assert log3["result"].tolist() == ["ok"] and c3.calls == [date(2026, 11, 5)]


def test_check():
    df = nsdl.parse_archive(page("nsdl_fpi_20261105.html"), date(2026, 11, 5))
    res = nsdl.check(df, sessions=[date(2026, 10, 30), date(2026, 11, 2)], today=date(2026, 11, 7))
    assert all(r.empty for r in res.values())
    bad = df.copy()
    bad.loc[0, "equity_net_cr"] += 100
    assert len(nsdl.check(bad, today=date(2026, 11, 7))["fpi_subtotal_mismatch"]) == 1
    assert not nsdl.check(df, today=date(2026, 12, 1))["fpi_stale"].empty
    assert not nsdl.check(pd.DataFrame())["fpi_missing"].empty
