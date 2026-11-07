"""Ingest calendar logic with a fake archive client (no network)."""

from datetime import date
from pathlib import Path

import pytest

from niftyquant import config, ingest
from niftyquant.nse import sources
from niftyquant.store import Manifest, read_dataset

FIX = Path(__file__).parent / "fixtures"
DAY = date(2026, 11, 6)  # Friday


class FakeClient:
    def __init__(self, files: dict[str, bytes]):
        self.files, self.calls = files, []

    def get(self, url):
        self.calls.append(url)
        return self.files.get(url)


def trading_day_files(d=DAY):
    return {
        sources.index_close(d): (FIX / "ind_close_20261106.csv").read_bytes(),
        sources.fo_bhavcopy_udiff(d): (FIX / "fo_udiff_20261106.csv.zip").read_bytes(),
        sources.participant_oi(d): (FIX / "participant_oi_20261106.csv").read_bytes(),
        sources.participant_vol(d): (FIX / "participant_vol_20261106.csv").read_bytes(),
    }


@pytest.fixture
def tmp_data(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CURATED_DIR", tmp_path / "curated")
    return Manifest(tmp_path / "manifest.sqlite")


def test_trading_day_writes_all_datasets(tmp_data):
    client = FakeClient(trading_day_files())
    res = ingest.ingest_day(client, tmp_data, DAY, ingest.ALL_DATASETS, today=date(2026, 11, 20))
    assert res == {ds: "ok" for ds in ingest.ALL_DATASETS}
    assert len(read_dataset("fo_bhavcopy")) > 0
    # Second run skips without network calls beyond nothing.
    client.calls.clear()
    res = ingest.ingest_day(client, tmp_data, DAY, ingest.ALL_DATASETS, today=date(2026, 11, 20))
    assert set(res.values()) == {"skip"} and client.calls == []


def test_weekday_holiday_checks_fo_then_marks_holiday(tmp_data):
    client = FakeClient({})
    res = ingest.ingest_day(client, tmp_data, DAY, ingest.ALL_DATASETS, today=date(2026, 11, 20))
    assert set(res.values()) == {"holiday"}
    assert any("BhavCopy" in u for u in client.calls)


def test_recent_absence_is_pending_not_holiday(tmp_data):
    res = ingest.ingest_day(FakeClient({}), tmp_data, DAY, ingest.ALL_DATASETS, today=DAY)
    assert set(res.values()) == {"pending"}
    assert set(tmp_data.statuses(DAY).values()) == {"pending"}


def test_index_gap_on_trading_day_is_reported_missing(tmp_data):
    files = trading_day_files()
    del files[sources.index_close(DAY)]
    res = ingest.ingest_day(FakeClient(files), tmp_data, DAY, ingest.ALL_DATASETS,
                            today=date(2026, 11, 20))
    assert res["index_close"] == "missing"
    assert res["fo_bhavcopy"] == res["participant_oi"] == "ok"


def test_parse_failure_recorded_as_error_and_retried(tmp_data):
    files = trading_day_files()
    files[sources.participant_oi(DAY)] = b"garbage"
    res = ingest.ingest_day(FakeClient(files), tmp_data, DAY, ingest.ALL_DATASETS,
                            today=date(2026, 11, 20))
    assert res["participant_oi"] == "error"
    files[sources.participant_oi(DAY)] = (FIX / "participant_oi_20261106.csv").read_bytes()
    res = ingest.ingest_day(FakeClient(files), tmp_data, DAY, ingest.ALL_DATASETS,
                            today=date(2026, 11, 20))
    assert res["participant_oi"] == "ok" and res["fo_bhavcopy"] == "skip"
