"""Parser tests against trimmed copies of real NSE files."""

from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from niftyquant.nse import parsers, sources

FIX = Path(__file__).parent / "fixtures"
UDIFF_DAY = date(2026, 11, 6)
LEGACY_DAY = date(2024, 7, 5)


def raw(name: str) -> bytes:
    return (FIX / name).read_bytes()


@pytest.fixture(scope="module")
def udiff():
    return parsers.parse_fo_udiff(raw("fo_udiff_20261106.csv.zip"), UDIFF_DAY, ("NIFTY",))


@pytest.fixture(scope="module")
def legacy():
    return parsers.parse_fo_legacy(raw("fo_legacy_20240705.csv.zip"), LEGACY_DAY, ("NIFTY",))


def test_schema_is_identical_across_formats(udiff, legacy):
    assert list(udiff.columns) == parsers.FO_COLUMNS == list(legacy.columns)
    assert udiff.dtypes.equals(legacy.dtypes)


def test_only_nifty_index_derivatives_kept(udiff, legacy):
    for df in (udiff, legacy):
        assert set(df["symbol"]) == {"NIFTY"}
        assert set(df["instrument"]) == {"FUT", "OPT"}


def test_udiff_near_future_values(udiff):
    fut = udiff[(udiff["instrument"] == "FUT") & (udiff["expiry"] == date(2026, 11, 23))].iloc[0]
    assert fut["close"] == 25032.40
    assert fut["underlying"] == 25030.35
    assert fut["volume_contracts"] == 125137
    assert fut["oi_units"] == 12088505
    assert fut["lot_size"] == 65 and fut["lot_size_source"] == "exchange"
    assert pd.isna(fut["strike"]) and pd.isna(fut["option_type"])


def test_udiff_options_have_strike_and_type(udiff):
    opt = udiff[udiff["instrument"] == "OPT"]
    assert opt["strike"].notna().all()
    assert set(opt["option_type"]) == {"CE", "PE"}
    assert set(opt["expiry"]) == {date(2026, 11, 9)}  # Monday expiry: holiday-shifted, taken from file


def test_legacy_values_and_turnover_units(legacy):
    fut = legacy[(legacy["instrument"] == "FUT") & (legacy["expiry"] == date(2024, 7, 25))].iloc[0]
    assert fut["close"] == 24379.4
    assert fut["volume_contracts"] == 230381
    assert fut["oi_units"] == 14171325
    assert fut["turnover_inr"] == pytest.approx(1400814.91 * 1e5)
    assert pd.isna(fut["underlying"])


def test_legacy_lot_size_is_derived_exactly(legacy):
    # Nifty lot size was 25 in July 2024.
    assert legacy["lot_size"].notna().all()
    assert set(legacy["lot_size"]) == {25}
    assert set(legacy["lot_size_source"]) == {"derived"}


def test_lot_derivation_reproduces_exchange_lot(udiff):
    blank = udiff.assign(lot_size=pd.NA, lot_size_source=None)
    blank["lot_size"] = blank["lot_size"].astype("Int64")
    derived = parsers.derive_lot_sizes(blank)
    assert (derived["lot_size"] == udiff["lot_size"]).all()


@pytest.mark.parametrize("title", [
    b"Nov 06,2026", b"November 06, 2026", b"Nov 6 , 2026", b'Nov 06,"2026"""""',
    b"Nov 06 2026", b'Nov 06 2026,"2026"""""', b"Nov 06 2026 ", b"Nov 06",  # all seen in NSE files
])
def test_participant_title_date_variants(title):
    body = raw("participant_oi_20261106.csv").replace(b"Nov 06, 2026", title)
    assert parsers.parse_participant(body, UDIFF_DAY)["trade_date"].iloc[0] == UDIFF_DAY


@pytest.mark.parametrize("title", [b"Nov 05, 2026", b"Nov 06, 2025", b"Nov 05", b"Oct 06 2026"])
def test_participant_title_wrong_date_rejected(title):
    body = raw("participant_oi_20261106.csv").replace(b"Nov 06, 2026", title)
    with pytest.raises(parsers.ParseError):
        parsers.parse_participant(body, UDIFF_DAY)


def test_participant_numbers_with_separators():
    lines = raw("participant_oi_20261106.csv").decode().splitlines()
    lines[2] = ",".join([f'"{int(v):,}.00"' if i else v for i, v in enumerate(lines[2].split(","))])
    df = parsers.parse_participant("\n".join(lines).encode(), UDIFF_DAY)
    assert df.loc[df["client_type"] == "Client", "future_index_long"].iloc[0] == 180828


def test_participant_without_title_line():
    body = b"\n".join(raw("participant_oi_20261106.csv").splitlines()[1:])
    assert len(parsers.parse_participant(body, UDIFF_DAY)) == 5


@pytest.mark.parametrize("stamp", [b"06/11/2026", b"11-06-2026"])  # slash form; month-first form
def test_index_close_date_variants(stamp):
    body = raw("ind_close_20261106.csv").replace(b"06-11-2026", stamp)
    assert parsers.parse_index_close(body, UDIFF_DAY).set_index("index_name").loc["Nifty 50", "close"] == 25030.35


def test_index_close_old_nifty_name_is_renamed():
    body = raw("ind_close_20261106.csv").replace(b"Nifty 50,06-11-2026", b"CNX Nifty,06-11-2026")
    df = parsers.parse_index_close(body, UDIFF_DAY).set_index("index_name")
    assert df.loc["Nifty 50", "close"] == 25030.35 and "CNX Nifty" not in df.index


def test_index_close_wrong_date_rejected():
    body = raw("ind_close_20261106.csv").replace(b"06-11-2026", b"05-11-2026")
    with pytest.raises(parsers.ParseError):
        parsers.parse_index_close(body, UDIFF_DAY)


def test_wrong_date_is_rejected():
    with pytest.raises(parsers.ParseError):
        parsers.parse_fo_udiff(raw("fo_udiff_20261106.csv.zip"), date(2026, 11, 5), ("NIFTY",))
    with pytest.raises(parsers.ParseError):
        parsers.parse_participant(raw("participant_oi_20261106.csv"), date(2026, 11, 5))


@pytest.mark.parametrize("name,day", [("participant_oi_20261106.csv", UDIFF_DAY),
                                      ("participant_oi_20180105.csv", date(2018, 1, 5)),
                                      ("participant_vol_20261106.csv", UDIFF_DAY)])
def test_participant(name, day):
    df = parsers.parse_participant(raw(name), day)
    assert set(df["client_type"]) == {"Client", "DII", "FII", "Pro", "TOTAL"}
    assert "future_stock_short" in df.columns  # trailing spaces in NSE header are cleaned
    nums = df.set_index("client_type").drop(columns="trade_date")
    tot = nums.loc["TOTAL"]
    # NSE's own totals can be off by a contract (2018-01-05: 4702856 long vs 4702855 short).
    assert abs(tot["total_long_contracts"] - tot["total_short_contracts"]) <= 2
    parts = nums.drop(index="TOTAL").sum()
    assert ((parts - tot).abs() <= 2).all()


@pytest.mark.parametrize("name,day,close,vix", [
    ("ind_close_20261106.csv", UDIFF_DAY, 25030.35, 17.47),
    ("ind_close_20180105.csv", date(2018, 1, 5), 10558.85, 13.11),
])
def test_index_close(name, day, close, vix):
    df = parsers.parse_index_close(raw(name), day).set_index("index_name")
    assert df.index.is_unique  # NSE repeats Nifty 50; deduplicated
    assert df.loc["Nifty 50", "close"] == close
    assert df.loc["India VIX", "close"] == vix
    assert pd.isna(df.loc["India VIX", "pe"])


def test_bhavcopy_url_switches_format_on_cutover():
    assert sources.fo_bhavcopy_candidates(date(2024, 7, 5))[0][0] == "legacy"
    assert sources.fo_bhavcopy_candidates(date(2024, 7, 8))[0][0] == "udiff"
    assert sources.fo_bhavcopy_legacy(date(2024, 7, 5)).endswith("/2024/JUL/fo05JUL2024bhav.csv.zip")
