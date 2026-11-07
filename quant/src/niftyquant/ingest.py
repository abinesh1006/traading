"""Download NSE end-of-day files for a date range into curated Parquet.

Calendar logic: the all-indices close file exists on every trading day (including
special weekend sessions), so it is fetched first and used to tell trading days
from holidays. On weekdays the F&O bhavcopy is also tried before declaring a holiday,
so a gap in the index archive is not mistaken for a market holiday.
"""

import logging
from collections.abc import Callable, Iterable
from datetime import date, timedelta

import pandas as pd

from . import config
from .nse import parsers, sources
from .nse.http import ArchiveClient
from .store import FINAL, Manifest, write_day

log = logging.getLogger(__name__)

INDEX = "index_close"
FO = "fo_bhavcopy"
POI = "participant_oi"
PVOL = "participant_vol"
ALL_DATASETS = (INDEX, FO, POI, PVOL)

# Files for a date may not be published until the evening (IST); treat recent
# absences as "pending" so the next run retries them.
PENDING_DAYS = 3


def _fetch_fo(client: ArchiveClient, d: date) -> tuple[pd.DataFrame | None, str]:
    for fmt, url in sources.fo_bhavcopy_candidates(d):
        raw = client.get(url)
        if raw is None:
            continue
        parse = parsers.parse_fo_udiff if fmt == "udiff" else parsers.parse_fo_legacy
        return parse(raw, d, config.FO_SYMBOLS), url
    return None, sources.fo_bhavcopy_candidates(d)[0][1]


def _simple(url_fn: Callable[[date], str], parse_fn) -> Callable:
    def fetch(client: ArchiveClient, d: date) -> tuple[pd.DataFrame | None, str]:
        url = url_fn(d)
        raw = client.get(url)
        return (None if raw is None else parse_fn(raw, d)), url
    return fetch


FETCHERS = {
    INDEX: _simple(sources.index_close, parsers.parse_index_close),
    FO: _fetch_fo,
    POI: _simple(sources.participant_oi, parsers.parse_participant),
    PVOL: _simple(sources.participant_vol, parsers.parse_participant),
}


def _run_one(client, manifest, dataset, d) -> str:
    try:
        df, url = FETCHERS[dataset](client, d)
    except Exception as e:  # recorded and retried on the next run
        log.error("%s %s failed: %s", dataset, d, e)
        manifest.record(dataset, d, "error", message=str(e)[:500])
        return "error"
    if df is None:
        return "absent"
    write_day(df, dataset, d)
    manifest.record(dataset, d, "ok", rows=len(df), url=url)
    return "ok"


def ingest_day(client: ArchiveClient, manifest: Manifest, d: date,
               datasets: Iterable[str], force: bool = False, today: date | None = None) -> dict:
    today = today or date.today()
    wanted = [ds for ds in ALL_DATASETS if ds in set(datasets)]
    done = manifest.statuses(d)
    if not force and all(done.get(ds) in FINAL for ds in wanted):
        return {ds: "skip" for ds in wanted}

    recent = (today - d).days < PENDING_DAYS
    result: dict[str, str] = {}

    # 1. Calendar probe.
    probe = _run_one(client, manifest, INDEX, d)
    trading = probe == "ok"
    if probe == "absent" and d.weekday() < 5:
        fo = _run_one(client, manifest, FO, d)
        result[FO] = fo
        if fo == "error":
            return result  # cannot tell trading day from holiday; retry the day next run
        trading = fo == "ok"
    if probe == "error":
        trading = True  # unknown; try everything and let errors be retried

    if not trading:
        status = "pending" if recent else "holiday"
        for ds in wanted:
            if result.get(ds) != "error":
                manifest.record(d=d, dataset=ds, status=status)
                result[ds] = status
        if INDEX not in wanted:
            manifest.record(INDEX, d, status)
        return result

    if INDEX in wanted:
        result[INDEX] = probe
    if probe == "absent":
        manifest.record(INDEX, d, "pending" if recent else "missing")
        result[INDEX] = "pending" if recent else "missing"

    for ds in wanted:
        if ds == INDEX or ds in result:
            continue
        if not force and done.get(ds) in FINAL:
            result[ds] = "skip"
            continue
        r = _run_one(client, manifest, ds, d)
        if r == "absent":
            r = "pending" if recent else "missing"
            manifest.record(ds, d, r)
        result[ds] = r
    return result


def ingest_range(start: date, end: date, datasets: Iterable[str] = ALL_DATASETS,
                 force: bool = False, client: ArchiveClient | None = None,
                 manifest: Manifest | None = None) -> pd.DataFrame:
    client = client or ArchiveClient()
    manifest = manifest or Manifest()
    datasets = tuple(datasets)
    rows = []
    d, n = start, 0
    total = (end - start).days + 1
    while d <= end:
        res = ingest_day(client, manifest, d, datasets, force=force)
        rows.extend({"trade_date": d, "dataset": k, "result": v} for k, v in res.items())
        n += 1
        if n % 50 == 0 or d == end:
            log.info("progress %d/%d days (at %s)", n, total, d)
        d += timedelta(days=1)
    return pd.DataFrame(rows)
