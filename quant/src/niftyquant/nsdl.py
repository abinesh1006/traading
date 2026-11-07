"""Daily FPI (FII) cash-market flows in Indian equity, from NSDL's FPI Monitor archive.

Source: https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx. Asking for a date returns every
reporting day of that month up to that date, so one request covers a month (back to 2015 and earlier).
Only the Equity block is kept:
- exch_*: trades on stock exchanges (the market flow traders talk about)
- primary_net_cr: IPOs, QIPs and other primary-market buying
- equity_net_cr: exchange + primary (NSDL "Sub-total")
Amounts are Rs crore. usd_inr is NSDL's conversion rate for that day.

Timing (verified on the page): NSDL compiles custodian-confirmed trades "on and up to the previous
trading day(s)", so the row for reporting date D mostly holds trades from the session before D.
It is published on D, so it can only be used from the session after D:
use `macro.align_to_sessions`-style joins with allow_exact_matches=False on reporting_date.
NSE's same-evening provisional FII/DII numbers are timelier but NSE keeps no history of them.

NSDL resets connections from Python's TLS stack (tested 2026-11-07) but accepts Windows curl
(Schannel), so requests go through the curl executable.
"""

import calendar
import html
import logging
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from . import config

log = logging.getLogger(__name__)

URL = "https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx"
USER_AGENT = "niftyquant/0.1"
START = date(2015, 1, 1)
# Months that ended this many days ago or more are final and not re-downloaded.
FINAL_AFTER_DAYS = 10

COLUMNS = ["reporting_date", "exch_buy_cr", "exch_sell_cr", "exch_net_cr", "primary_net_cr",
           "equity_buy_cr", "equity_sell_cr", "equity_net_cr", "equity_net_usd_mn", "usd_inr"]

_DATE = re.compile(r"^\d{2}-[A-Z][a-z]{2}-\d{4}$")
_NUM = re.compile(r"^\(?-?[\d,]+(\.\d+)?\)?$")


class ParseError(ValueError):
    pass


# ---------------------------------------------------------------- parsing

def _cells(row_html: str) -> list[str]:
    cells = re.findall(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>", row_html)
    return [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip() for c in cells]


def _num(s: str) -> float:
    neg = s.startswith("(") and s.endswith(")")
    v = float(s.strip("()").replace(",", ""))
    return -v if neg else v


def parse_archive(raw: bytes | str, requested: date) -> pd.DataFrame:
    """The 'Daily Trends in FPI Investments up to <date>' table -> one row per reporting date."""
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    title = re.search(r"Daily Trends in FPI Investments up to (\d{2}-[A-Za-z]{3}-\d{4})", text)
    if not title:
        raise ParseError("no 'Daily Trends in FPI Investments' table in response")
    if datetime.strptime(title.group(1), "%d-%b-%Y").date() != requested:
        raise ParseError(f"page is for {title.group(1)}, requested {requested}")
    start = title.start()
    end = text.find("</table>", start)
    rows = re.findall(r"(?is)<tr[^>]*>(.*?)</tr>", text[start:end])

    out: dict[date, dict] = {}
    day: date | None = None
    asset: str | None = None
    month_total: float | None = None
    for r in rows:
        c = _cells(r)
        if not c or not any(_NUM.match(x) for x in c):
            continue  # header rows
        if c[0].startswith("Total for"):
            # Month (then year) totals follow the daily rows; keep the month's equity net as a cross-check.
            if month_total is None and len(c) > 6 and c[1] == "Equity":
                month_total = _num(c[5])
            break
        if _DATE.match(c[0]):
            day = datetime.strptime(c[0], "%d-%b-%Y").date()
            c = c[1:]
            if c and c[-1].startswith("Rs."):
                out.setdefault(day, {})["usd_inr"] = float(c[-1][3:].replace(",", ""))
                c = c[:-1]
        labels = [x for x in c if not _NUM.match(x)]
        nums = [_num(x) for x in c if _NUM.match(x)]
        if day is None or len(nums) != 4 or len(labels) not in (1, 2):
            raise ParseError(f"unexpected row layout: {c}")
        if len(labels) == 2:
            asset = labels[0]
        route = labels[-1]
        if route == "Total":
            asset = None
            continue
        if asset != "Equity":
            continue
        buy, sell, net, usd = nums
        if abs(buy - sell - net) > 0.05:
            raise ParseError(f"{day} {route}: buy - sell != net ({buy} - {sell} != {net})")
        d = out.setdefault(day, {})
        if route == "Stock Exchange":
            d |= {"exch_buy_cr": buy, "exch_sell_cr": sell, "exch_net_cr": net}
        elif route.startswith("Primary market"):
            d["primary_net_cr"] = net
        elif route == "Sub-total":
            d |= {"equity_buy_cr": buy, "equity_sell_cr": sell, "equity_net_cr": net, "equity_net_usd_mn": usd}
        else:
            raise ParseError(f"unknown equity route {route!r} on {day}")

    if not out:
        raise ParseError(f"no reporting days found up to {requested}")
    df = pd.DataFrame([{"reporting_date": d, **v} for d, v in out.items()])
    missing = [c for c in COLUMNS if c not in df.columns or df[c].isna().any()]
    if missing:
        raise ParseError(f"missing fields {missing} up to {requested}")
    if not all(d.year == requested.year and d.month == requested.month and d <= requested for d in out):
        raise ParseError(f"reporting dates outside {requested:%Y-%m}")
    if month_total is None:
        raise ParseError(f"no month total up to {requested}")
    if abs(df["exch_net_cr"].sum() - month_total) > 1.0:
        raise ParseError(f"daily exchange net sums to {df['exch_net_cr'].sum():.2f}, month total {month_total}")
    return df[COLUMNS].sort_values("reporting_date").reset_index(drop=True)


def hidden_fields(page: str) -> dict[str, str]:
    fields = dict(re.findall(r'<input type="hidden" name="(__\w+)" id="\w+" value="([^"]*)"', page))
    if "__VIEWSTATE" not in fields:
        raise ParseError("ASP.NET form fields not found on the archive page")
    return fields


# ---------------------------------------------------------------- download

class CurlClient:
    """Minimal ASP.NET form session over the curl executable (keeps cookies in a temp file)."""

    def __init__(self, min_interval: float = 1.5, retries: int = 3, timeout: int = 90):
        self.min_interval, self.retries, self.timeout = min_interval, retries, timeout
        fd, self.jar = tempfile.mkstemp(prefix="nsdl_cookies_")
        os.close(fd)
        self._last = 0.0
        self._fields: dict[str, str] | None = None

    def close(self) -> None:
        try:
            os.remove(self.jar)
        except OSError:
            pass

    def _curl(self, form: dict[str, str] | None) -> str:
        cmd = ["curl", "-sS", "--fail", "-m", str(self.timeout), "-A", USER_AGENT,
               "-c", self.jar, "-b", self.jar, URL]
        body = None
        if form is not None:
            # The form goes in a file: ASP.NET state can exceed Windows' 32k command-line limit.
            fd, body = tempfile.mkstemp(prefix="nsdl_form_")
            with os.fdopen(fd, "w", encoding="ascii") as f:
                f.write(urllib.parse.urlencode(form))
            cmd += ["--data-binary", f"@{body}"]
        try:
            return self._run(cmd)
        finally:
            if body:
                os.remove(body)

    def _run(self, cmd: list[str]) -> str:
        error = None
        for attempt in range(self.retries + 1):
            wait = self.min_interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            p = subprocess.run(cmd, capture_output=True, timeout=self.timeout + 30)
            if p.returncode == 0 and p.stdout:
                return p.stdout.decode("utf-8", errors="replace")
            error = p.stderr.decode(errors="replace").strip() or f"curl exit {p.returncode}"
            log.warning("NSDL retry %d: %s", attempt + 1, error)
            time.sleep(min(60, 3 * 2**attempt))
        raise RuntimeError(f"NSDL request failed: {error}")

    def month_until(self, d: date) -> str:
        if self._fields is None:
            self._fields = hidden_fields(self._curl(None))
        ds = d.strftime("%d-%b-%Y")
        form = self._fields | {"__EVENTTARGET": "btnSubmit1", "__EVENTARGUMENT": "", "txtDate": ds,
                               "hdnDate": ds, "HdnValexceldata": "", "hdnFlag": ""}
        # The blank form's state is reused for every month (the posted-back state embeds the
        # result table and grows past 100 KB).
        return self._curl(form)


def month_path(year: int, month: int, root: Path | None = None) -> Path:
    return (root or config.CURATED_DIR) / "nsdl" / "fpi_equity" / f"year={year}" / f"{year}-{month:02d}.parquet"


def _months(start: date, end: date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def fetch(start: date = START, end: date | None = None, force: bool = False,
          client=None, root: Path | None = None, today: date | None = None) -> pd.DataFrame:
    """Download month by month; final months already on disk are skipped. Returns a log frame."""
    today = today or date.today()
    end = min(end or today, today)
    own = client is None
    client = client or CurlClient()
    rows = []
    try:
        for y, m in _months(start, end):
            last = date(y, m, calendar.monthrange(y, m)[1])
            p = month_path(y, m, root)
            final = (today - last).days >= FINAL_AFTER_DAYS
            if p.exists() and final and not force:
                rows.append({"month": f"{y}-{m:02d}", "result": "skip", "days": None})
                continue
            until = min(last, today)
            try:
                df = parse_archive(client.month_until(until), until)
            except Exception as e:  # logged; the month is retried next run
                log.error("NSDL %d-%02d failed: %s", y, m, e)
                rows.append({"month": f"{y}-{m:02d}", "result": "error", "days": None})
                continue
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".parquet.tmp")
            df.to_parquet(tmp, index=False, compression="zstd")
            os.replace(tmp, p)
            rows.append({"month": f"{y}-{m:02d}", "result": "ok", "days": len(df)})
            log.info("NSDL %d-%02d: %d reporting days", y, m, len(df))
    finally:
        if own:
            client.close()
    return pd.DataFrame(rows)


def read(root: Path | None = None) -> pd.DataFrame:
    files = sorted(((root or config.CURATED_DIR) / "nsdl" / "fpi_equity").glob("year=*/*.parquet"))
    if not files:
        return pd.DataFrame(columns=COLUMNS)
    return pd.concat((pd.read_parquet(f) for f in files), ignore_index=True).sort_values("reporting_date")


def check(df: pd.DataFrame, sessions=None, today: date | None = None) -> dict[str, pd.DataFrame]:
    """Quality checks; an empty frame means pass. `sessions` = NSE trading dates, to find gaps."""
    if df.empty:
        return {"fpi_missing": pd.DataFrame({"message": ["no NSDL FPI data; run `niftyquant fpi`"]})}
    today = today or date.today()
    out = {
        "fpi_duplicates": df[df.duplicated("reporting_date", keep=False)],
        "fpi_subtotal_mismatch": df[(df["exch_net_cr"] + df["primary_net_cr"] - df["equity_net_cr"]).abs() > 0.05],
        "fpi_stale": pd.DataFrame({"last": [df["reporting_date"].max()]})
        if (today - df["reporting_date"].max()).days > 7 else pd.DataFrame(),
    }
    if sessions is not None:
        # A month of NSE sessions should have NSDL reporting days too; flag months with none.
        s = pd.Series(pd.to_datetime(pd.Series(sessions)).dt.to_period("M").unique())
        have = set(pd.to_datetime(df["reporting_date"]).dt.to_period("M"))
        first = pd.Timestamp(df["reporting_date"].min()).to_period("M")
        out["fpi_months_without_data"] = pd.DataFrame({"month": [str(p) for p in s if p >= first and p not in have]})
    return out
