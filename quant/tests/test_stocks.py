"""Stock-level parsers (cash market, stock F&O) and the stocks downloader."""

from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from niftyquant import config, stocks
from niftyquant.nse import parsers, sources
from niftyquant.store import Manifest, write_day

FIX = Path(__file__).parent / "fixtures"
NOV6, JAN5 = date(2026, 11, 6), date(2018, 1, 5)


def raw(name):
    return (FIX / name).read_bytes()


def test_cm_formats_share_schema_and_values():
    new = parsers.parse_cm_udiff(raw("cm_udiff_20261106.csv.zip"), NOV6)
    old = parsers.parse_cm_legacy(raw("cm_legacy_20180105.csv.zip"), JAN5)
    assert list(new.columns) == list(old.columns) == parsers.CM_COLUMNS
    r = new.set_index("symbol").loc["RELIANCE"]
    assert (r["close"], r["prev_close"], r["volume_shares"]) == (1320.00, 1313.4, 22768301)
    assert old.set_index("symbol").loc["RELIANCE", "close"] == 923.25
    assert set(new["series"]) <= {"EQ", "BE"} and "M&M" in set(new["symbol"])


def test_cm_wrong_date_rejected():
    with pytest.raises(parsers.ParseError):
        parsers.parse_cm_udiff(raw("cm_udiff_20261106.csv.zip"), date(2026, 11, 5))


def test_stock_fo_keeps_only_stock_contracts_for_requested_symbols():
    df = parsers.parse_fo_udiff(raw("fo_udiff_stock_20261106.csv.zip"), NOV6, ("RELIANCE",), kind="stock")
    assert set(df["symbol"]) == {"RELIANCE"} and set(df["instrument"]) == {"FUT", "OPT"}
    fut = df[(df["instrument"] == "FUT") & (df["expiry"] == date(2026, 11, 23))].iloc[0]
    assert fut["close"] == 1323.00 and fut["lot_size"] == 500
    # The index parser on the same file finds nothing: stock rows only.
    assert parsers.parse_fo_udiff(raw("fo_udiff_stock_20261106.csv.zip"), NOV6, ("RELIANCE",)).empty


def test_stock_fo_legacy_lot_size_derived():
    df = parsers.parse_fo_legacy(raw("fo_legacy_stock_20180105.csv.zip"), JAN5, ("RELIANCE",), kind="stock")
    assert set(df["lot_size"]) == {1000} and set(df["lot_size_source"]) == {"derived"}


class FakeClient:
    def __init__(self, files):
        self.files = files

    def get(self, url):
        return self.files.get(url)


def test_fetch_writes_days_and_records_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CURATED_DIR", tmp_path / "curated")
    # Two F&O sessions in the store; only one has a cash-market file.
    for d in (NOV6, date(2026, 11, 5)):
        write_day(pd.DataFrame({"x": [1]}), "fo_bhavcopy", d)
    client = FakeClient({sources.cm_bhavcopy_udiff(NOV6): raw("cm_udiff_20261106.csv.zip")})
    manifest = Manifest(tmp_path / "m.sqlite")
    res = stocks.fetch([stocks.CM], start=date(2026, 11, 1), client=client, manifest=manifest,
                       today=date(2026, 12, 1))
    assert dict(zip(res["trade_date"], res["result"])) == {date(2026, 11, 5): "missing", NOV6: "ok"}
    assert stocks.read_cm(symbols=["RELIANCE"])["close"].tolist() == [1320.00]
    # A second run only retries the missing day.
    again = stocks.fetch([stocks.CM], start=date(2026, 11, 1), client=client, manifest=manifest,
                         today=date(2026, 12, 1))
    assert again["trade_date"].tolist() == [date(2026, 11, 5)]


def test_legacy_dates_with_two_digit_year():
    # NSE's 2020-07-13 cash-market file stamps its rows 13-Jul-20, unlike every other legacy file.
    assert parsers._legacy_date("13-Jul-20") == date(2020, 7, 13)
    assert parsers._legacy_date(" 05-JAN-2018 ") == JAN5
