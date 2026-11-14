"""Trading costs for Nifty futures and options by trade date: what a backtest must subtract.

Every charge below changed over time, so each is a dated step table, and the rate in force on the
trade date is used. Percentages are of premium value (price x quantity) for options and of contract
value for futures. Researched 2026-11-07; sources are noted per table. If a rule changes, add a row.

Per executed order (each side):
- brokerage: the broker's flat fee per order (INDmoney offer Rs 5, Dhan Rs 20); a parameter
- exchange: NSE transaction charge plus NSE IPFT contribution (both sides)
- sebi: SEBI turnover fee (both sides)
- stt: Securities Transaction Tax, sell side only (plus exercise STT on ITM options held to expiry)
- stamp: stamp duty, buy side only
- gst: 18% on brokerage + exchange + SEBI fee
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from datetime import date

CRORE = 1e7

# STT, % of value, sell side. Finance Act 2016 (from 2016-06-01: options 0.05%), Finance Act 2023
# (from 2023-04-01; NSE circular FATAX56235), Finance (No. 2) Act 2024 (from 2024-10-01), Budget 2026 /
# Finance Act 2026 (from 2026-04-01: futures 0.05%, options 0.15%, exercise 0.15%).
STT_OPTION_SELL = ((date(2016, 6, 1), 0.05), (date(2023, 4, 1), 0.0625), (date(2024, 10, 1), 0.10),
                   (date(2026, 4, 1), 0.15))
STT_FUTURE_SELL = ((date(2016, 6, 1), 0.01), (date(2023, 4, 1), 0.0125), (date(2024, 10, 1), 0.02),
                   (date(2026, 4, 1), 0.05))
# Options held to expiry in the money are exercised: STT on the intrinsic value, paid by the buyer.
STT_OPTION_EXERCISE = ((date(2016, 6, 1), 0.125), (date(2026, 4, 1), 0.15))

# NSE transaction charge + IPFT contribution, Rs per crore, each side (options on premium value).
# - to 2020-12-31: options 5,000, futures 190 (standard published rates; slab-wise before Oct 2024,
#   retail brokers passed on these)
# - 2021-01-01: +6% (NSE, for the IPF corpus): options 5,300, futures 200
# - 2023-04-01: 6% rolled back, IPFT raised to 50 (options) / 10 (futures): 5,000+50, 190+10
#   (NSE circular NSE/FA/56129, 2023-03-24)
# - 2024-04-01: options 4,950+50, futures 188+10 (rates brokers listed as "old" in Sep 2024)
# - 2024-10-01: uniform rates per SEBI circular 2024/92: options 3,503+50, futures 173+10
#   (NSE circular NSE/FA/64323, 2024-09-27)
# - 2026-03-01: IPFT folded back into the transaction charge with "no impact in the overall outflow"
#   (NSE/FA/73061, 2026-02-27), so the total is unchanged.
EXCHANGE_OPTION_PER_CR = ((date(2016, 6, 1), 5000.0), (date(2021, 1, 1), 5300.0), (date(2023, 4, 1), 5050.0),
                          (date(2024, 4, 1), 5000.0), (date(2024, 10, 1), 3553.0))
EXCHANGE_FUTURE_PER_CR = ((date(2016, 6, 1), 190.0), (date(2021, 1, 1), 200.0), (date(2023, 4, 1), 200.0),
                          (date(2024, 4, 1), 198.0), (date(2024, 10, 1), 183.0))

# SEBI turnover fee, Rs per crore, each side. Halved for June 2020 - March 2021 (SEBI press release
# 2020-04-27). SEBI cut it from 15 to 10 in 2019 (board decision 2019-03-01; effective date not
# verified, so 10 is used throughout: the difference is Rs 0.05 per lakh).
SEBI_PER_CR = ((date(2016, 6, 1), 10.0), (date(2020, 6, 1), 5.0), (date(2021, 4, 1), 10.0))

# Stamp duty, % of value, buy side. Uniform national rates from 2020-07-01 (Indian Stamp Act
# amendment). Before that it varied by the client's state; the same rates are used as an approximation.
STAMP_OPTION_BUY = ((date(2016, 6, 1), 0.003),)
STAMP_FUTURE_BUY = ((date(2016, 6, 1), 0.002),)

GST = ((date(2017, 7, 1), 18.0),)  # % on brokerage + exchange + SEBI fee (service tax 15% before)


def rate_on(table, d: date) -> float:
    """Value of a dated step table in force on d."""
    i = bisect_right([start for start, _ in table], d) - 1
    if i < 0:
        raise ValueError(f"cost rules are not modelled before {table[0][0]} (asked for {d})")
    return table[i][1]


@dataclass(frozen=True)
class Charges:
    brokerage: float
    exchange: float
    sebi: float
    stt: float
    stamp: float
    gst: float

    @property
    def total(self) -> float:
        return self.brokerage + self.exchange + self.sebi + self.stt + self.stamp + self.gst

    def __add__(self, other: Charges) -> Charges:
        return Charges(*(a + b for a, b in zip(self.as_tuple(), other.as_tuple())))

    def as_tuple(self) -> tuple[float, ...]:
        return (self.brokerage, self.exchange, self.sebi, self.stt, self.stamp, self.gst)


def order_charges(d: date, instrument: str, side: str, price: float, quantity: int,
                  brokerage_per_order: float = 5.0) -> Charges:
    """Charges for one executed order. instrument 'OPT' or 'FUT'; side 'buy' or 'sell';
    quantity in units (lots x lot size); price per unit (option premium or futures price)."""
    if instrument not in ("OPT", "FUT"):
        raise ValueError(f"instrument must be OPT or FUT, not {instrument!r}")
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy or sell, not {side!r}")
    if price < 0 or quantity <= 0:
        raise ValueError("price must be >= 0 and quantity > 0")
    value = price * quantity
    opt = instrument == "OPT"
    exchange = value * rate_on(EXCHANGE_OPTION_PER_CR if opt else EXCHANGE_FUTURE_PER_CR, d) / CRORE
    sebi = value * rate_on(SEBI_PER_CR, d) / CRORE
    stt = value * rate_on(STT_OPTION_SELL if opt else STT_FUTURE_SELL, d) / 100 if side == "sell" else 0.0
    stamp = value * rate_on(STAMP_OPTION_BUY if opt else STAMP_FUTURE_BUY, d) / 100 if side == "buy" else 0.0
    gst = (brokerage_per_order + exchange + sebi) * rate_on(GST, d) / 100
    return Charges(brokerage_per_order, exchange, sebi, stt, stamp, gst)


def round_trip(d: date, instrument: str, entry_price: float, exit_price: float, quantity: int,
               long: bool = True, brokerage_per_order: float = 5.0) -> Charges:
    """Entry and exit orders on the same day (intraday)."""
    first, second = ("buy", "sell") if long else ("sell", "buy")
    return (order_charges(d, instrument, first, entry_price, quantity, brokerage_per_order)
            + order_charges(d, instrument, second, exit_price, quantity, brokerage_per_order))


def exercise_stt(expiry: date, intrinsic_per_unit: float, quantity: int) -> float:
    """STT a long option holder pays when an ITM option is exercised at expiry (no order, no brokerage)."""
    return max(intrinsic_per_unit, 0.0) * quantity * rate_on(STT_OPTION_EXERCISE, expiry) / 100
