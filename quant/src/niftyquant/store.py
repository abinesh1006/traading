"""Curated storage: one Parquet file per dataset per trading day, plus a fetch manifest.

Layout: data/curated/nse/<dataset>/year=YYYY/YYYY-MM-DD.parquet
The manifest (SQLite) records the outcome of every fetch so runs are resumable
and gaps are auditable.
"""

import os
import sqlite3
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

from . import config

# Final statuses are never retried unless --force is given.
FINAL = {"ok", "holiday"}


def day_path(dataset: str, d: date, root: Path | None = None) -> Path:
    root = root or config.CURATED_DIR
    return root / "nse" / dataset / f"year={d.year}" / f"{d.isoformat()}.parquet"


def write_day(df: pd.DataFrame, dataset: str, d: date, root: Path | None = None) -> Path:
    path = day_path(dataset, d, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    df.to_parquet(tmp, index=False, compression="zstd")
    os.replace(tmp, path)
    return path


def read_dataset(dataset: str, start: date | None = None, end: date | None = None,
                 root: Path | None = None) -> pd.DataFrame:
    root = root or config.CURATED_DIR
    files = sorted((root / "nse" / dataset).glob("year=*/*.parquet"))
    keep = [f for f in files
            if (start is None or date.fromisoformat(f.stem) >= start)
            and (end is None or date.fromisoformat(f.stem) <= end)]
    if not keep:
        return pd.DataFrame()
    return pd.concat((pd.read_parquet(f) for f in keep), ignore_index=True)


class Manifest:
    def __init__(self, path: Path | None = None):
        self.path = path or config.MANIFEST_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._conn()) as c, c:
            c.execute(
                """CREATE TABLE IF NOT EXISTS fetch_log (
                       dataset TEXT NOT NULL, trade_date TEXT NOT NULL, status TEXT NOT NULL,
                       rows INTEGER, url TEXT, message TEXT, fetched_at TEXT NOT NULL,
                       PRIMARY KEY (dataset, trade_date))"""
            )

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def record(self, dataset: str, d: date, status: str, rows: int | None = None,
               url: str | None = None, message: str | None = None) -> None:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with closing(self._conn()) as c, c:
            c.execute(
                "INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?,?,?,?)",
                (dataset, d.isoformat(), status, rows, url, message, now),
            )

    def statuses(self, d: date) -> dict[str, str]:
        with closing(self._conn()) as c:
            rows = c.execute("SELECT dataset, status FROM fetch_log WHERE trade_date=?",
                             (d.isoformat(),)).fetchall()
        return dict(rows)

    def frame(self) -> pd.DataFrame:
        with closing(self._conn()) as c:
            return pd.read_sql_query("SELECT * FROM fetch_log", c, parse_dates=["trade_date"])
