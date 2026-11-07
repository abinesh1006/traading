"""NSE provisional FII/DII recorder (no network)."""

from datetime import date

import pytest

from niftyquant import fiidii

RAW = (b'[{"buyValue":"18084.32","category":"DII","date":"06-Nov-2026","netValue":"-5968.7","sellValue":"24053.02"},'
       b'{"buyValue":"30455.63","category":"FII/FPI","date":"06-Nov-2026","netValue":"13749.82","sellValue":"16705.81"}]')


def test_parse():
    df = fiidii.parse(RAW)
    assert df["category"].tolist() == ["DII", "FII"]
    assert df.loc[1, "net_cr"] == pytest.approx(13749.82)
    assert (df["trade_date"] == date(2026, 11, 6)).all()


@pytest.mark.parametrize("bad", [
    RAW.replace(b"13749.82", b"13000.00"),           # buy - sell != net
    RAW.replace(b'"DII"', b'"MF"'),                  # unknown category
    RAW.replace(b"06-Nov-2026\",\"netValue\":\"-5968.7", b"05-Nov-2026\",\"netValue\":\"-5968.7"),  # two dates
])
def test_parse_rejects(bad):
    with pytest.raises(fiidii.ParseError):
        fiidii.parse(bad)


def test_fetch_saves_by_served_date_and_check(tmp_path):
    fiidii.fetch(get=lambda url: RAW, root=tmp_path)
    df = fiidii.read(root=tmp_path)
    assert len(df) == 2
    res = fiidii.check(df, sessions=[date(2026, 11, 5), date(2026, 11, 6), date(2026, 11, 9)])
    assert res["fii_dii_missed_days"]["trade_date"].tolist() == [date(2026, 11, 9)]
