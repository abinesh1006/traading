"""Risk-free rate for option pricing: the RBI policy repo rate as a step function.

91-day T-bill yields track the repo rate closely, and in Black-76 the rate only discounts the
premium (a few basis points of IV at most for Nifty's short expiries), so a policy-rate step
series is accurate enough and has no data source to break.

Each entry is (effective date, rate %), the day the MPC (or an off-cycle RBI action) announced it.
Verified against RBI announcements as reported in the press; add new decisions as they happen and
re-run `niftyquant greeks --full`.
"""

from __future__ import annotations

from bisect import bisect_right
from datetime import date

REPO_RATE_CHANGES: tuple[tuple[date, float], ...] = (
    (date(2014, 1, 28), 8.00),
    (date(2015, 1, 15), 7.75),   # off-cycle cut
    (date(2015, 3, 4), 7.50),    # off-cycle cut
    (date(2015, 6, 2), 7.25),
    (date(2015, 9, 29), 6.75),
    (date(2016, 4, 5), 6.50),
    (date(2016, 10, 4), 6.25),
    (date(2017, 8, 2), 6.00),
    (date(2018, 6, 6), 6.25),
    (date(2018, 8, 1), 6.50),
    (date(2019, 2, 7), 6.25),
    (date(2019, 4, 4), 6.00),
    (date(2019, 6, 6), 5.75),
    (date(2019, 8, 7), 5.40),
    (date(2019, 10, 4), 5.15),
    (date(2020, 3, 27), 4.40),   # off-cycle COVID cut
    (date(2020, 5, 22), 4.00),   # off-cycle COVID cut
    (date(2022, 5, 4), 4.40),    # off-cycle hike
    (date(2022, 6, 8), 4.90),
    (date(2022, 8, 5), 5.40),
    (date(2022, 9, 30), 5.90),
    (date(2022, 12, 7), 6.25),
    (date(2023, 2, 8), 6.50),
    (date(2025, 2, 7), 6.25),
    (date(2025, 4, 9), 6.00),
    (date(2025, 6, 6), 5.50),
    (date(2025, 12, 5), 5.25),
    (date(2026, 10, 7), 5.50),
)

_DATES = [d for d, _ in REPO_RATE_CHANGES]


def repo_rate(d: date) -> float:
    """Repo rate in force on date d, as a decimal (6.5% -> 0.065)."""
    i = bisect_right(_DATES, d) - 1
    if i < 0:
        raise ValueError(f"no repo rate before {_DATES[0]}")
    return REPO_RATE_CHANGES[i][1] / 100
