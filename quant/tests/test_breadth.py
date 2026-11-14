"""NSE market breadth (Market Activity report): parsing real files and the resumable fetch (no network)."""

from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from niftyquant import breadth
from niftyquant.store import write_day

FIX = Path(__file__).parent / "fixtures"
D26, D15 = date(2026, 11, 6), date(2015, 1, 5)


def raw(name):
    return (FIX / name).read_bytes()


def test_parse_2026():
    r = breadth.parse(raw("ma_20261106.csv"), D26).iloc[0]
    assert (r["advances"], r["declines"], r["unchanged"], r["price_band_hits"]) == (1550, 2283, 110, 332)
    assert r["traded_value_cr"] == pytest.approx(153106.35) and r["trades"] == 46348210
    assert r["market_cap_cr"] == pytest.approx(49918269.20) and r["traded_qty_lakh"] == pytest.approx(56132.57)


def test_parse_2015():
    r = breadth.parse(raw("ma_20150105.csv"), D15).iloc[0]
    assert (r["advances"], r["declines"], r["unchanged"], r["price_band_hits"]) == (768, 762, 70, 141)
    assert r["traded_value_cr"] == pytest.approx(13677.11)


def test_parse_rejects_wrong_date_and_truncated_file():
    with pytest.raises(breadth.ParseError):
        breadth.parse(raw("ma_20261106.csv"), date(2026, 11, 5))
    head = b"\n".join(raw("ma_20261106.csv").split(b"\n")[:20])  # stops before ADVANCES
    with pytest.raises(breadth.ParseError):
        breadth.parse(head, D26)


class FakeClient:
    def __init__(self, files):
        self.files, self.calls = files, []

    def get(self, url):
        self.calls.append(url)
        return self.files.get(url)


@pytest.fixture
def root(tmp_path):
    for d in (D26, date(2026, 11, 5)):  # our calendar: days with an index_close file
        write_day(pd.DataFrame({"trade_date": [d], "index_name": ["Nifty 50"]}), "index_close", d, tmp_path)
    return tmp_path


def test_fetch_only_missing_trading_days_and_check(root):
    c = FakeClient({breadth.url(D26): raw("ma_20261106.csv")})
    log = breadth.fetch(client=c, root=root, today=date(2026, 11, 20))
    assert dict(zip(log["trade_date"], log["result"])) == {date(2026, 11, 5): "missing", D26: "ok"}
    again = breadth.fetch(client=FakeClient({}), root=root, today=date(2026, 11, 20))
    assert again["trade_date"].tolist() == [date(2026, 11, 5)]  # saved day skipped, missing retried
    res = breadth.check(breadth.read(root=root), sessions=[date(2026, 11, 5), D26], today=date(2026, 11, 20))
    assert res["breadth_missing_days"]["trade_date"].tolist() == [date(2026, 11, 5)]


def test_recent_absent_day_is_pending(root):
    log = breadth.fetch(client=FakeClient({}), root=root, today=date(2026, 11, 7))
    assert set(log["result"]) == {"pending"}
