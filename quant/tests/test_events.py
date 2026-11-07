"""Event calendar: reference data sanity, reaction-session rule, timestamps."""

from datetime import date

import numpy as np
import pandas as pd

from niftyquant import events


def test_reference_lists_are_sorted_unique_and_in_range():
    ref = events.reference_events()
    assert not ref.duplicated(["event_date", "category", "name"]).any()
    for cat, g in ref.groupby("category"):
        assert g["event_date"].is_monotonic_increasing, cat
    assert ref["event_date"].min() >= date(2015, 1, 1)


def test_rbi_rate_path_is_consistent():
    prev = None
    for d, repo, bp, _, _ in events.RBI_POLICY:
        if prev is not None and np.isfinite(repo):
            assert round(prev + bp / 100, 2) == repo, d
        prev = repo if np.isfinite(repo) else prev


def test_reaction_session_same_day_or_next():
    sessions = np.array([date(2026, 11, 5), date(2026, 11, 6), date(2026, 11, 9)], dtype=object)
    assert events.reaction_session(date(2026, 11, 6), False, sessions) == date(2026, 11, 6)
    assert events.reaction_session(date(2026, 11, 6), True, sessions) == date(2026, 11, 9)  # weekend skipped
    assert events.reaction_session(date(2026, 11, 7), False, sessions) == date(2026, 11, 9)
    assert events.reaction_session(date(2026, 11, 9), True, sessions) is None


def test_us_event_times_follow_daylight_saving():
    t = events.event_time_ist
    assert t(date(2026, 3, 18), "fomc", "").strftime("%Y-%m-%d %H:%M") == "2026-03-18 23:30"
    assert t(date(2026, 12, 9), "fomc", "").strftime("%Y-%m-%d %H:%M") == "2026-12-10 00:30"
    assert t(date(2026, 1, 13), "us_cpi", "").strftime("%H:%M") == "19:00"
    assert t(date(2026, 8, 3), "expiry", "").strftime("%H:%M") == "15:40"
    assert t(date(2026, 7, 28), "expiry", "").strftime("%H:%M") == "15:30"
    assert t(date(2026, 10, 7), "rbi_policy", "") is None


def test_build_on_synthetic_market():
    days = pd.bdate_range("2026-10-26", "2026-11-06").date
    dm = pd.DataFrame({"trade_date": days, "spot_close": np.linspace(25000, 25500, len(days)),
                       "spot_return_pct": [0.1] * len(days), "vix_close": 15.0,
                       "near_expiry": date(2026, 11, 3), "fut_expiry": date(2026, 11, 24)})
    dm.loc[dm["trade_date"] == date(2026, 10, 29), "spot_return_pct"] = -3.0  # big move -> shock
    iv = pd.DataFrame({"trade_date": days, "near_atm_iv": 15.87})
    ev = events.build(dm, iv)
    fomc = ev[(ev["category"] == "fomc") & (ev["event_date"] == date(2026, 10, 28))].iloc[0]
    assert fomc["reaction_session"] == date(2026, 10, 29) and fomc["nifty_move_pct"] == -3.0
    assert abs(fomc["surprise"] - 3.0 / (15.87 / np.sqrt(252))) < 1e-9
    shock = ev[ev["category"] == "market_shock"]
    assert shock["event_date"].tolist() == [date(2026, 10, 29)] and not shock["verified"].iloc[0]
    exp = ev[ev["category"] == "expiry"].iloc[0]
    assert exp["name"] == "Weekly expiry"  # 3 Nov has no future; 24 Nov does
    imp = events.category_impact(ev, dm, iv)
    assert imp.loc[imp["category"] == "all_days", "move_vs_normal"].iloc[0] == 1.0
