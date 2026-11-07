"""Market event calendar and each event's measured impact on Nifty.

Reference lists below were compiled on 2026-11-07 from official sources where possible:
- FOMC decisions: federalreserve.gov calendars (2015-2026), statement release dates.
- US CPI releases: bls.gov CPI release archive (October 2025 CPI was never published: shutdown).
- RBI policy: RBI press releases (2026), bankbazaar's rate-change table and press coverage
  (Business Standard, Business Today, BloombergQuint and others); `verified=False` marks meetings whose
  date fits the rate path but was not confirmed by a source during compilation.
- Union Budgets, elections: public record; weekend sessions are confirmed by NSE's own files.
- Special sessions: detected in NSE data (weekend sessions; Diwali Muhurat sessions trade ~15-35% of
  normal volume), labelled here.
- Market shocks: the data picks the days (|Nifty move| >= 2.8% or India VIX up >= 25%); causes are
  attached where known, with the source checked for 2025-2026 events. Days without a known cause keep
  cause = None rather than a guess.

Each event gets the first NSE session that could react ("reaction session"): RBI, Budget and election
results land during Indian market hours (same day); FOMC statements (14:00 ET) and US CPI (08:30 ET =
18:00-19:00 IST) and exit polls land after the Indian close, so they hit the next session.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import analytics

D = date.fromisoformat

# (decision date, repo after %, change bp, off-cycle, verified)
RBI_POLICY: tuple[tuple[str, float, int, bool, bool], ...] = (
    ("2015-01-15", 7.75, -25, True, True), ("2015-02-03", 7.75, 0, False, True),
    ("2015-03-04", 7.50, -25, True, True), ("2015-04-07", 7.50, 0, False, True),
    ("2015-06-02", 7.25, -25, False, True), ("2015-08-04", 7.25, 0, False, True),
    ("2015-09-29", 6.75, -50, False, True), ("2015-12-01", 6.75, 0, False, False),
    ("2016-02-02", 6.75, 0, False, True), ("2016-04-05", 6.50, -25, False, True),
    ("2016-06-07", 6.50, 0, False, False), ("2016-08-09", 6.50, 0, False, False),
    ("2016-10-04", 6.25, -25, False, True), ("2016-12-07", 6.25, 0, False, False),
    ("2017-02-08", 6.25, 0, False, False), ("2017-04-06", 6.25, 0, False, False),
    ("2017-06-07", 6.25, 0, False, True), ("2017-08-02", 6.00, -25, False, True),
    ("2017-10-04", 6.00, 0, False, True), ("2017-12-06", 6.00, 0, False, True),
    ("2018-02-07", 6.00, 0, False, True), ("2018-04-05", 6.00, 0, False, True),
    ("2018-06-06", 6.25, 25, False, True), ("2018-08-01", 6.50, 25, False, True),
    ("2018-10-05", 6.50, 0, False, False), ("2018-12-05", 6.50, 0, False, False),
    ("2019-02-07", 6.25, -25, False, True), ("2019-04-04", 6.00, -25, False, True),
    ("2019-06-06", 5.75, -25, False, True), ("2019-08-07", 5.40, -35, False, True),
    ("2019-10-04", 5.15, -25, False, True), ("2019-12-05", 5.15, 0, False, True),
    ("2020-02-06", 5.15, 0, False, True), ("2020-03-27", 4.40, -75, True, True),
    ("2020-05-22", 4.00, -40, True, True), ("2020-08-06", 4.00, 0, False, True),
    ("2020-10-09", 4.00, 0, False, True), ("2020-12-04", 4.00, 0, False, True),
    ("2021-02-05", 4.00, 0, False, True), ("2021-04-07", 4.00, 0, False, True),
    ("2021-06-04", 4.00, 0, False, True), ("2021-08-06", 4.00, 0, False, True),
    ("2021-10-08", 4.00, 0, False, False), ("2021-12-08", 4.00, 0, False, True),
    ("2022-02-10", 4.00, 0, False, True), ("2022-04-08", 4.00, 0, False, False),
    ("2022-05-04", 4.40, 40, True, True), ("2022-06-08", 4.90, 50, False, True),
    ("2022-08-05", 5.40, 50, False, True), ("2022-09-30", 5.90, 50, False, True),
    ("2022-12-07", 6.25, 35, False, True), ("2023-02-08", 6.50, 25, False, True),
    ("2023-04-06", 6.50, 0, False, True), ("2023-06-08", 6.50, 0, False, True),
    ("2023-08-10", 6.50, 0, False, True), ("2023-10-06", 6.50, 0, False, True),
    ("2023-12-08", 6.50, 0, False, True), ("2024-02-08", 6.50, 0, False, True),
    ("2024-04-05", 6.50, 0, False, True), ("2024-06-07", 6.50, 0, False, False),
    ("2024-08-08", 6.50, 0, False, True), ("2024-10-09", 6.50, 0, False, False),
    ("2024-12-06", 6.50, 0, False, True), ("2025-02-07", 6.25, -25, False, True),
    ("2025-04-09", 6.00, -25, False, True), ("2025-06-06", 5.50, -50, False, True),
    ("2025-08-06", 5.50, 0, False, True), ("2025-10-01", 5.50, 0, False, True),
    ("2025-12-05", 5.25, -25, False, True), ("2026-02-06", 5.25, 0, False, True),
    ("2026-04-08", 5.25, 0, False, True), ("2026-06-05", 5.25, 0, False, True),
    ("2026-08-05", 5.25, 0, False, True), ("2026-10-07", 5.50, 25, False, True),
    ("2026-12-04", np.nan, 0, False, False),  # scheduled (Dec 2-4 meeting); outcome unknown
)

FOMC_UNSCHEDULED = {"2019-10-11", "2020-03-03", "2020-03-15"}
FOMC: tuple[str, ...] = (
    "2015-01-28", "2015-03-18", "2015-04-29", "2015-06-17", "2015-07-29", "2015-09-17", "2015-10-28", "2015-12-16",
    "2016-01-27", "2016-03-16", "2016-04-27", "2016-06-15", "2016-07-27", "2016-09-21", "2016-11-02", "2016-12-14",
    "2017-02-01", "2017-03-15", "2017-05-03", "2017-06-14", "2017-07-26", "2017-09-20", "2017-11-01", "2017-12-13",
    "2018-01-31", "2018-03-21", "2018-05-02", "2018-06-13", "2018-08-01", "2018-09-26", "2018-11-08", "2018-12-19",
    "2019-01-30", "2019-03-20", "2019-05-01", "2019-06-19", "2019-07-31", "2019-09-18", "2019-10-11", "2019-10-30",
    "2019-12-11", "2020-01-29", "2020-03-03", "2020-03-15", "2020-04-29", "2020-06-10", "2020-07-29", "2020-09-16",
    "2020-11-05", "2020-12-16", "2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22",
    "2021-11-03", "2021-12-15", "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21",
    "2022-11-02", "2022-12-14", "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20",
    "2023-11-01", "2023-12-13", "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18",
    "2024-11-07", "2024-12-18", "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17",
    "2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16",
    "2026-10-28", "2026-12-09",
)

# US CPI release dates (bls.gov archive); reference month as 'Mon-YYYY'.
def _cpi() -> tuple[tuple[str, str], ...]:
    raw = """2015-01-16 Dec-2014;2015-02-26 Jan-2015;2015-03-24 Feb-2015;2015-04-17 Mar-2015;2015-05-22 Apr-2015;
    2015-06-18 May-2015;2015-07-17 Jun-2015;2015-08-19 Jul-2015;2015-09-16 Aug-2015;2015-10-15 Sep-2015;
    2015-11-17 Oct-2015;2015-12-15 Nov-2015;2016-01-20 Dec-2015;2016-02-19 Jan-2016;2016-03-16 Feb-2016;
    2016-04-14 Mar-2016;2016-05-17 Apr-2016;2016-06-16 May-2016;2016-07-15 Jun-2016;2016-08-16 Jul-2016;
    2016-09-16 Aug-2016;2016-10-18 Sep-2016;2016-11-17 Oct-2016;2016-12-15 Nov-2016;2017-01-18 Dec-2016;
    2017-02-15 Jan-2017;2017-03-15 Feb-2017;2017-04-14 Mar-2017;2017-05-12 Apr-2017;2017-06-14 May-2017;
    2017-07-14 Jun-2017;2017-08-11 Jul-2017;2017-09-14 Aug-2017;2017-10-13 Sep-2017;2017-11-15 Oct-2017;
    2017-12-13 Nov-2017;2018-01-12 Dec-2017;2018-02-14 Jan-2018;2018-03-13 Feb-2018;2018-04-11 Mar-2018;
    2018-05-10 Apr-2018;2018-06-12 May-2018;2018-07-12 Jun-2018;2018-08-10 Jul-2018;2018-09-13 Aug-2018;
    2018-10-11 Sep-2018;2018-11-14 Oct-2018;2018-12-12 Nov-2018;2019-01-11 Dec-2018;2019-02-13 Jan-2019;
    2019-03-12 Feb-2019;2019-04-10 Mar-2019;2019-05-10 Apr-2019;2019-06-12 May-2019;2019-07-11 Jun-2019;
    2019-08-13 Jul-2019;2019-09-12 Aug-2019;2019-10-10 Sep-2019;2019-11-13 Oct-2019;2019-12-11 Nov-2019;
    2020-01-14 Dec-2019;2020-02-13 Jan-2020;2020-03-11 Feb-2020;2020-04-10 Mar-2020;2020-05-12 Apr-2020;
    2020-06-10 May-2020;2020-07-14 Jun-2020;2020-08-12 Jul-2020;2020-09-11 Aug-2020;2020-10-13 Sep-2020;
    2020-11-12 Oct-2020;2020-12-10 Nov-2020;2021-01-13 Dec-2020;2021-02-10 Jan-2021;2021-03-10 Feb-2021;
    2021-04-13 Mar-2021;2021-05-12 Apr-2021;2021-06-10 May-2021;2021-07-13 Jun-2021;2021-08-11 Jul-2021;
    2021-09-14 Aug-2021;2021-10-13 Sep-2021;2021-11-10 Oct-2021;2021-12-10 Nov-2021;2022-01-12 Dec-2021;
    2022-02-10 Jan-2022;2022-03-10 Feb-2022;2022-04-12 Mar-2022;2022-05-11 Apr-2022;2022-06-10 May-2022;
    2022-07-13 Jun-2022;2022-08-10 Jul-2022;2022-09-13 Aug-2022;2022-10-13 Sep-2022;2022-11-10 Oct-2022;
    2022-12-13 Nov-2022;2023-01-12 Dec-2022;2023-02-14 Jan-2023;2023-03-14 Feb-2023;2023-04-12 Mar-2023;
    2023-05-10 Apr-2023;2023-06-13 May-2023;2023-07-12 Jun-2023;2023-08-10 Jul-2023;2023-09-13 Aug-2023;
    2023-10-12 Sep-2023;2023-11-14 Oct-2023;2023-12-12 Nov-2023;2024-01-11 Dec-2023;2024-02-13 Jan-2024;
    2024-03-12 Feb-2024;2024-04-10 Mar-2024;2024-05-15 Apr-2024;2024-06-12 May-2024;2024-07-11 Jun-2024;
    2024-08-14 Jul-2024;2024-09-11 Aug-2024;2024-10-10 Sep-2024;2024-11-13 Oct-2024;2024-12-11 Nov-2024;
    2025-01-15 Dec-2024;2025-02-12 Jan-2025;2025-03-12 Feb-2025;2025-04-10 Mar-2025;2025-05-13 Apr-2025;
    2025-06-11 May-2025;2025-07-15 Jun-2025;2025-08-12 Jul-2025;2025-09-11 Aug-2025;2025-10-24 Sep-2025;
    2025-12-18 Nov-2025;2026-01-13 Dec-2025;2026-02-13 Jan-2026;2026-03-11 Feb-2026;2026-04-10 Mar-2026;
    2026-05-12 Apr-2026;2026-06-10 May-2026;2026-07-14 Jun-2026;2026-08-12 Jul-2026;2026-09-11 Aug-2026;
    2026-10-14 Sep-2026;2026-11-10 Oct-2026;2026-12-10 Nov-2026"""
    return tuple(tuple(x.split()) for x in raw.replace("\n", "").split(";"))


US_CPI = _cpi()

# (date, kind) Union Budget presentations, 11:00 IST. Weekend ones had special NSE sessions.
BUDGETS: tuple[tuple[str, str], ...] = (
    ("2015-02-28", "full"), ("2016-02-29", "full"), ("2017-02-01", "full"), ("2018-02-01", "full"),
    ("2019-02-01", "interim"), ("2019-07-05", "full"), ("2020-02-01", "full"), ("2021-02-01", "full"),
    ("2022-02-01", "full"), ("2023-02-01", "full"), ("2024-02-01", "interim"), ("2024-07-23", "full"),
    ("2025-02-01", "full"), ("2026-02-01", "full"),
)

# (date, name, after_close) Lok Sabha general elections: exit polls (evening of the last phase) and
# counting day (results during market hours).
ELECTIONS: tuple[tuple[str, str, bool], ...] = (
    ("2019-05-19", "Lok Sabha 2019 exit polls", True),
    ("2019-05-23", "Lok Sabha 2019 results", False),
    ("2024-06-01", "Lok Sabha 2024 exit polls", True),
    ("2024-06-04", "Lok Sabha 2024 results", False),
)

# Special NSE sessions, all confirmed by NSE's own files (weekend bhavcopies, or Diwali days with a
# fraction of normal volume). 2026-11-08 is announced (14:20-15:30 IST per broker notices of the
# NSE circular) and not yet in the data.
SPECIAL_SESSIONS: tuple[tuple[str, str], ...] = (
    ("2015-02-28", "Budget session (Saturday)"), ("2015-11-11", "Diwali Muhurat"),
    ("2016-10-30", "Diwali Muhurat"), ("2017-10-19", "Diwali Muhurat"), ("2018-11-07", "Diwali Muhurat"),
    ("2019-10-27", "Diwali Muhurat"), ("2020-02-01", "Budget session (Saturday)"),
    ("2020-11-14", "Diwali Muhurat"), ("2021-11-04", "Diwali Muhurat"), ("2022-10-24", "Diwali Muhurat"),
    ("2023-11-12", "Diwali Muhurat"), ("2024-01-20", "Special full session (Saturday)"),
    ("2024-03-02", "Live disaster-recovery session (Saturday)"),
    ("2024-05-18", "Live disaster-recovery session (Saturday)"), ("2024-11-01", "Diwali Muhurat"),
    ("2025-02-01", "Budget session (Saturday)"), ("2025-10-21", "Diwali Muhurat"),
    ("2026-02-01", "Budget session (Sunday)"), ("2026-11-08", "Diwali Muhurat (announced)"),
)

# Causes for big-move days (the days themselves come from the data). Keyed by NSE session date.
SHOCK_CAUSES: dict[str, str] = {
    "2015-08-24": "Global sell-off after China's yuan devaluation (Black Monday)",
    "2016-09-29": "Indian Army announces surgical strikes across the LoC (during market hours)",
    "2019-05-20": "Lok Sabha exit polls point to a clear NDA majority",
    "2019-09-20": "Corporate tax cut announced by the Finance Minister (during market hours)",
    "2019-09-23": "Follow-through rally after the corporate tax cut",
    "2020-02-28": "Global COVID-19 sell-off",
    "2020-03-09": "COVID-19 crash; Saudi-Russia oil price war",
    "2020-03-12": "COVID-19 crash; WHO declares a pandemic",
    "2020-03-13": "COVID-19: rebound after a lower-circuit open",
    "2020-03-16": "COVID-19 crash",
    "2020-03-18": "COVID-19 crash",
    "2020-03-20": "COVID-19: relief rally",
    "2020-03-23": "COVID-19 crash: worst day since 2008; state lockdowns",
    "2020-03-25": "COVID-19: rally on relief-package hopes; national lockdown announced the evening before",
    "2020-03-26": "COVID-19: relief package announced",
    "2020-03-30": "COVID-19 volatility",
    "2020-03-31": "COVID-19 volatility",
    "2020-04-01": "COVID-19 volatility",
    "2020-04-07": "Global rally on hopes of a COVID-19 peak",
    "2020-04-09": "COVID-19 volatility",
    "2020-04-17": "RBI liquidity measures (TLTRO 2.0, reverse repo cut)",
    "2020-04-21": "COVID-19 volatility; US oil futures collapse",
    "2020-04-30": "COVID-19 volatility",
    "2020-05-04": "Lockdown extended; US-China tensions",
    "2020-05-18": "Disappointment with the stimulus package details",
    "2020-05-27": "COVID-19 volatility",
    "2020-12-21": "New COVID-19 strain found in the UK",
    "2021-02-01": "Union Budget 2021 (growth-focused)",
    "2021-02-26": "Global bond-yield spike",
    "2021-04-12": "Second COVID-19 wave in India",
    "2021-11-26": "Omicron variant reported",
    "2022-02-14": "Russia-Ukraine tensions",
    "2022-02-15": "Russia-Ukraine de-escalation hopes",
    "2022-02-24": "Russia invades Ukraine",
    "2024-06-03": "Lok Sabha 2024 exit polls point to a large NDA win",
    "2024-06-04": "Lok Sabha 2024 results: BJP short of a majority on its own",
    "2024-06-05": "Rebound as NDA allies confirm support",
    "2024-08-05": "Global sell-off: yen carry-trade unwind, US growth fears",
    "2025-04-07": "Global crash after US reciprocal tariffs (announced 2 Apr)",
    "2025-05-12": "Rally after the India-Pakistan ceasefire (10 May)",
    "2026-03-02": "US-Iran / West Asia conflict escalates; crude spikes; India VIX +25%",
    "2026-03-19": "Gulf war escalation, crude above $110, FII selling; Nifty's worst month in six years",
    "2026-04-08": "US-Iran two-week ceasefire, crude falls (RBI held rates the same day)",
    "2026-07-08": "Renewed US-Iran tensions, Strait of Hormuz risk; India VIX +26%",
}
FILE = "market_events.parquet"
IMPACT_FILE = "event_impact.parquet"
SHOCK_MOVE_PCT = 2.8  # |Nifty close-to-close move| that makes a day a "market shock"
SHOCK_VIX_PCT = 25.0   # or an India VIX jump this large

CATEGORY_LABELS = {
    "rbi_policy": "RBI policy decision", "fomc": "US Fed (FOMC) decision", "us_cpi": "US CPI release",
    "union_budget": "Union Budget", "election": "General election", "special_session": "Special NSE session",
    "market_shock": "Market shock (big move)",
}
CATEGORY_LABELS["expiry"] = "Nifty option expiry"
EVENT_COLUMNS = ["event_date", "event_time_ist", "category", "name", "after_close", "verified", "change_bp",
                 "reaction_session", "nifty_move_pct", "vix_change_pct", "expected_move_pct", "vix_close", "surprise"]

IST = ZoneInfo("Asia/Kolkata")
ET = ZoneInfo("America/New_York")
FO_CLOSE_1540_FROM = D("2026-08-03")  # NSE F&O close moved from 15:30 to 15:40


def _at(d: date, hhmm: str, tz: ZoneInfo) -> pd.Timestamp:
    """Wall-clock time in a zone, as an IST timestamp (handles US daylight saving)."""
    return pd.Timestamp(datetime.fromisoformat(f"{d.isoformat()}T{hhmm}").replace(tzinfo=tz).astimezone(IST))


def event_time_ist(d: date, category: str, name: str) -> pd.Timestamp | None:
    """Scheduled release time where it is fixed by rule; None where it varied or is unknown
    (RBI announcement times changed over the years; Muhurat timings vary; shocks have no single time)."""
    if category == "fomc":
        return _at(d, "14:00", ET)          # statement at 2:00 p.m. Eastern
    if category == "us_cpi":
        return _at(d, "08:30", ET)          # BLS releases at 8:30 a.m. Eastern
    if category == "union_budget":
        return _at(d, "11:00", IST)
    if category == "election":
        return _at(d, "18:30", IST) if "exit polls" in name else _at(d, "08:00", IST)  # polls after voting; counting at 08:00
    if category == "expiry":
        return _at(d, "15:40" if d >= FO_CLOSE_1540_FROM else "15:30", IST)
    if category == "special_session" and d == D("2026-11-08"):
        return _at(d, "14:20", IST)
    return None


def expiry_events(dm: pd.DataFrame) -> pd.DataFrame:
    """Every Nifty option expiry seen in the data (each becomes the nearest expiry at some point).
    Monthly = an expiry that also has a futures contract (Nifty futures expire only monthly); the
    "last expiry of the month" rule would mislabel the newest week before later weeklies are listed."""
    exps = sorted({e for e in dm["near_expiry"].dropna()})
    monthly = set(dm["fut_expiry"].dropna())
    return pd.DataFrame({"event_date": exps, "category": "expiry",
                         "name": ["Monthly expiry" if e in monthly else "Weekly expiry" for e in exps],
                         "after_close": False, "verified": True, "change_bp": None})


def reference_events() -> pd.DataFrame:
    """Every listed event, one row each. `after_close`: lands after the Indian close (reacts next session)."""
    rows = []
    for d, repo, bp, off, ok in RBI_POLICY:
        change = "hold" if bp == 0 else f"{'+' if bp > 0 else ''}{bp} bp"
        name = f"RBI policy: {change}, repo {repo:.2f}%" if np.isfinite(repo) else "RBI policy decision (scheduled)"
        rows.append((d, "rbi_policy", name + (" (off-cycle)" if off else ""), False, ok, bp))
    for d in FOMC:
        rows.append((d, "fomc", "FOMC decision" + (" (unscheduled)" if d in FOMC_UNSCHEDULED else ""), True, True, None))
    for d, ref in US_CPI:
        rows.append((d, "us_cpi", f"US CPI for {ref.replace('-', ' ')}", True, True, None))
    for d, kind in BUDGETS:
        rows.append((d, "union_budget", f"Union Budget ({kind})", False, True, None))
    for d, name, after in ELECTIONS:
        rows.append((d, "election", name, after, True, None))
    for d, name in SPECIAL_SESSIONS:
        rows.append((d, "special_session", name, False, True, None))
    df = pd.DataFrame(rows, columns=["event_date", "category", "name", "after_close", "verified", "change_bp"])
    df["event_date"] = df["event_date"].map(D)
    return df


def reaction_session(event_date: date, after_close: bool, sessions: np.ndarray) -> date | None:
    """First NSE session that could react: the same day if the event lands before the close."""
    i = np.searchsorted(sessions, event_date, side="right" if after_close else "left")
    return sessions[i] if i < len(sessions) else None


def build(dm: pd.DataFrame | None = None, iv: pd.DataFrame | None = None) -> pd.DataFrame:
    """Events joined to Nifty's move on their reaction session, against the move options priced in.

    expected_move_pct = previous session's nearest-expiry ATM IV / sqrt(252): a one-day, one-sigma move.
    surprise = |move| / expected (about 0.8 on an ordinary day).
    """
    dm = analytics.load_derived(analytics.DAILY_MARKET) if dm is None else dm
    iv = analytics.load_derived(analytics.IV_DAILY) if iv is None else iv
    if dm.empty:
        return pd.DataFrame(columns=EVENT_COLUMNS)
    mkt = dm[["trade_date", "spot_close", "spot_return_pct", "vix_close"]].sort_values("trade_date").copy()
    mkt["vix_change_pct"] = mkt["vix_close"].pct_change() * 100
    if not iv.empty:
        mkt = mkt.merge(iv[["trade_date", "near_atm_iv"]], on="trade_date", how="left")
        mkt["expected_move_pct"] = mkt["near_atm_iv"].shift(1) / np.sqrt(252)
    else:
        mkt["expected_move_pct"] = np.nan
    sessions = np.array(sorted(mkt["trade_date"]), dtype=object)

    big = mkt[(mkt["spot_return_pct"].abs() >= SHOCK_MOVE_PCT) | (mkt["vix_change_pct"] >= SHOCK_VIX_PCT)]
    shocks = pd.DataFrame({
        "event_date": big["trade_date"].to_numpy(), "category": "market_shock",
        "name": [SHOCK_CAUSES.get(d.isoformat(), "Large move, cause not attributed") for d in big["trade_date"]],
        "after_close": False, "verified": [d.isoformat() in SHOCK_CAUSES for d in big["trade_date"]],
        "change_bp": None,
    })
    ev = pd.concat([reference_events(), expiry_events(dm), shocks], ignore_index=True)
    ev["event_time_ist"] = [event_time_ist(d, c, n) for d, c, n in zip(ev["event_date"], ev["category"], ev["name"])]
    ev["event_time_ist"] = pd.to_datetime(ev["event_time_ist"], utc=True).dt.tz_convert(IST)
    ev["reaction_session"] = [reaction_session(d, a, sessions) for d, a in zip(ev["event_date"], ev["after_close"])]
    ev = ev.merge(mkt[["trade_date", "spot_return_pct", "vix_change_pct", "expected_move_pct", "vix_close"]]
                  .rename(columns={"trade_date": "reaction_session", "spot_return_pct": "nifty_move_pct"}),
                  on="reaction_session", how="left")
    ev["surprise"] = ev["nifty_move_pct"].abs() / ev["expected_move_pct"]
    ev["change_bp"] = pd.array(ev["change_bp"], dtype="Int64")
    ev["after_close"] = ev["after_close"].astype(bool)
    ev["verified"] = ev["verified"].astype(bool)
    return ev[EVENT_COLUMNS].sort_values(["event_date", "category"]).reset_index(drop=True)


def category_impact(ev: pd.DataFrame, dm: pd.DataFrame | None = None, iv: pd.DataFrame | None = None) -> pd.DataFrame:
    """Per category: Nifty's move on reaction sessions against all sessions (a baseline row, 'all_days')."""
    dm = analytics.load_derived(analytics.DAILY_MARKET) if dm is None else dm
    iv = analytics.load_derived(analytics.IV_DAILY) if iv is None else iv
    base = dm[["trade_date", "spot_return_pct", "vix_close"]].sort_values("trade_date").copy()
    base["vix_change_pct"] = base["vix_close"].pct_change() * 100
    if not iv.empty:
        base = base.merge(iv[["trade_date", "near_atm_iv"]], on="trade_date", how="left")
        base["surprise"] = base["spot_return_pct"].abs() / (base["near_atm_iv"].shift(1) / np.sqrt(252))
    else:
        base["surprise"] = np.nan

    def row(cat, label, moves, surprise, vix):
        moves = moves.dropna()
        return {"category": cat, "label": label, "events": len(moves),
                "median_abs_move_pct": moves.abs().median(), "mean_abs_move_pct": moves.abs().mean(),
                "p90_abs_move_pct": moves.abs().quantile(0.9) if len(moves) else np.nan,
                "share_up_pct": (moves > 0).mean() * 100 if len(moves) else np.nan,
                "median_surprise": surprise.median(), "median_vix_change_pct": vix.median()}

    out = [row(cat, CATEGORY_LABELS.get(cat, cat), g["nifty_move_pct"], g["surprise"], g["vix_change_pct"])
           for cat, g in ev.dropna(subset=["nifty_move_pct"]).groupby("category")]
    out.append(row("all_days", "All sessions (baseline)", base["spot_return_pct"], base["surprise"],
                   base["vix_change_pct"]))
    df = pd.DataFrame(out)
    df["move_vs_normal"] = df["median_abs_move_pct"] / df.loc[df["category"] == "all_days", "median_abs_move_pct"].iloc[0]
    return df.sort_values("move_vs_normal", ascending=False).reset_index(drop=True)
