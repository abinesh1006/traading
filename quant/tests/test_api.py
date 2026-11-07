"""Derived tables and research API, built from fixture files in a temporary data dir."""

from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from niftyquant import analytics, api, config, ingest
from niftyquant.nse import sources
from niftyquant.store import Manifest

FIX = Path(__file__).parent / "fixtures"
DAY = date(2026, 11, 6)


class FakeClient:
    def __init__(self, files):
        self.files = files

    def get(self, url):
        return self.files.get(url)


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    root = tmp_path_factory.mktemp("data")
    mp = pytest.MonkeyPatch()
    mp.setattr(config, "DATA_DIR", root)
    mp.setattr(config, "CURATED_DIR", root / "curated")
    mp.setattr(config, "MANIFEST_PATH", root / "manifest.sqlite")
    mp.setattr(config, "REPORTS_DIR", root / "reports")
    files = {
        sources.index_close(DAY): (FIX / "ind_close_20261106.csv").read_bytes(),
        sources.fo_bhavcopy_udiff(DAY): (FIX / "fo_udiff_20261106.csv.zip").read_bytes(),
        sources.participant_oi(DAY): (FIX / "participant_oi_20261106.csv").read_bytes(),
        sources.participant_vol(DAY): (FIX / "participant_vol_20261106.csv").read_bytes(),
    }
    ingest.ingest_day(FakeClient(files), Manifest(), DAY, ingest.ALL_DATASETS, today=date(2026, 11, 20))
    analytics.build_derived()
    yield TestClient(api.app)
    mp.undo()


def test_daily_market_row(client):
    rows = client.get("/market/daily").json()
    assert len(rows) == 1
    r = rows[0]
    assert r["trade_date"] == "2026-11-06"
    assert r["spot_close"] == 25030.35 and r["vix_close"] == 17.47
    assert r["fut_expiry"] == "2026-11-23" and r["fut_close"] == 25032.40
    assert r["basis_pct"] == pytest.approx((25032.40 / 25030.35 - 1) * 100)
    assert r["near_expiry"] == "2026-11-09" and r["days_to_expiry"] == 3
    assert r["lot_size"] == 65
    assert r["atm_strike"] % 50 == 0 and abs(r["atm_strike"] - 25030.35) <= 100
    assert 0 < r["atm_straddle_pct"] < 5
    assert r["near_pcr_oi"] == pytest.approx(r["near_pe_oi_units"] / r["near_ce_oi_units"])


def test_incremental_rebuild_matches_full(client):
    incremental = analytics.build_daily_market()
    full = analytics.build_daily_market(full=True)
    assert incremental.equals(full) and len(full) == 1


def test_date_filter(client):
    assert client.get("/market/daily", params={"start": "2026-11-07"}).json() == []


def test_participants(client):
    rows = client.get("/market/participants").json()
    assert {r["client_type"] for r in rows} == {"Client", "DII", "FII", "Pro"}
    fii = next(r for r in rows if r["client_type"] == "FII")
    assert fii["fut_index_net"] == 48656 - 149072


def test_chain(client):
    body = client.get("/market/chain", params={"date": "2026-11-06"}).json()
    assert body["expiry"] == "2026-11-09" and body["expiries"] == ["2026-11-09"]
    assert body["spot_close"] == 25030.35 and body["lot_size"] == 65
    strikes = [r["strike"] for r in body["rows"]]
    assert strikes == sorted(strikes) and len(strikes) > 50
    assert all(k in body["rows"][0] for k in ("ce_oi_units", "pe_oi_units", "ce_close", "pe_close"))


def test_chain_errors(client):
    assert client.get("/market/chain", params={"date": "2026-11-07"}).status_code == 404
    bad = client.get("/market/chain", params={"date": "2026-11-06", "expiry": "2026-11-10"})
    assert bad.status_code == 400


def test_data_status(client):
    body = client.get("/data/status").json()
    names = {d["dataset"] for d in body["datasets"]}
    assert names == set(ingest.ALL_DATASETS)
    fo = next(d for d in body["datasets"] if d["dataset"] == "fo_bhavcopy")
    assert fo["totals"]["ok"] == 1 and fo["last_date"] == "2026-11-06"


def test_iv_daily_and_chain_greeks(client):
    iv = client.get("/market/iv").json()
    assert len(iv) == 1 and iv[0]["trade_date"] == "2026-11-06"
    assert iv[0]["near_expiry"] == "2026-11-09" and 5 < iv[0]["near_atm_iv"] < 60
    chain = client.get("/market/chain", params={"date": "2026-11-06"}).json()
    assert abs(chain["forward"] / 25030.35 - 1) < 0.005
    traded = [r for r in chain["rows"] if (r["ce_volume_contracts"] or 0) > 0 and r["ce_iv_pct"] is not None]
    assert traded and all(0 < r["ce_delta"] < 1 and r["ce_theta"] < 0 for r in traded)


def test_events_endpoints(client):
    ev = client.get("/market/events").json()
    cats = {e["category"] for e in ev}
    assert {"rbi_policy", "fomc", "us_cpi", "union_budget", "expiry"} <= cats
    fomc = next(e for e in ev if e["category"] == "fomc" and e["event_date"] == "2026-10-28")
    assert fomc["event_time_ist"] == "2026-10-28T23:30:00+05:30" and fomc["after_close"] is True
    # Only one session of market data in the fixture: events after it have no reaction yet.
    assert all(e["reaction_session"] in (None, "2026-11-06") for e in ev)
    rbi = client.get("/market/events", params={"category": "rbi_policy", "start": "2026-01-01"}).json()
    assert [e["event_date"] for e in rbi][:2] == ["2026-02-06", "2026-04-08"]
    impact = client.get("/market/events/impact").json()
    assert any(r["category"] == "all_days" for r in impact)


def test_results_endpoints(client):
    from niftyquant import results
    # The fixture has no stock data, so the study is empty until it is built.
    assert client.get("/market/results").status_code == 503
    ev = pd.DataFrame([
        {"symbol": "TCS", "quarter": "Q1 FY25", "reaction_session": date(2024, 7, 12), "source": "confirmed",
         "return_pct": 6.63, "implied_move_pct": 3.8, "nifty_points": 61.6},
        {"symbol": "INFY", "quarter": "Q1 FY25", "reaction_session": date(2024, 7, 19), "source": "confirmed",
         "return_pct": 1.99, "implied_move_pct": float("nan"), "nifty_points": 30.1},
    ]).reindex(columns=results.COLUMNS)
    analytics.write_derived(results.FILE, ev)
    analytics.write_derived(results.SUMMARY_FILE, results.summarize(ev))
    try:
        got = client.get("/market/results", params={"symbol": "tcs"}).json()
        assert [(r["symbol"], r["reaction_session"], r["return_pct"]) for r in got] == [("TCS", "2024-07-12", 6.63)]
        assert len(client.get("/market/results", params={"start": "2024-07-15"}).json()) == 1
        assert client.get("/market/results").json()[1]["implied_move_pct"] is None  # NaN -> null
        summary = client.get("/market/results/summary").json()
        assert summary[-1]["symbol"] == "ALL" and summary[-1]["announcements"] == 2
    finally:  # leave the module's data dir as the other tests expect it
        for name in (results.FILE, results.SUMMARY_FILE):
            (analytics.derived_dir() / name).unlink()
