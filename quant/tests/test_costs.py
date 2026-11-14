"""Date-dependent trading costs."""

from datetime import date

import pytest

from niftyquant import costs


@pytest.mark.parametrize("d, opt, fut", [
    (date(2018, 10, 1), 0.05, 0.01),
    (date(2023, 3, 31), 0.05, 0.01),
    (date(2023, 4, 1), 0.0625, 0.0125),
    (date(2024, 9, 30), 0.0625, 0.0125),
    (date(2024, 10, 1), 0.10, 0.02),
    (date(2026, 3, 31), 0.10, 0.02),
    (date(2026, 4, 1), 0.15, 0.05),
])
def test_stt_steps(d, opt, fut):
    assert costs.rate_on(costs.STT_OPTION_SELL, d) == opt
    assert costs.rate_on(costs.STT_FUTURE_SELL, d) == fut


def test_before_modelled_period_raises():
    with pytest.raises(ValueError):
        costs.rate_on(costs.STT_OPTION_SELL, date(2015, 1, 1))


def test_option_round_trip_2026_11_06():
    # 1 lot of 65, bought at 150 and sold at 170, Rs 5 per order.
    c = costs.round_trip(date(2026, 11, 6), "OPT", 150.0, 170.0, 65)
    buy_value, sell_value = 150 * 65, 170 * 65
    assert c.brokerage == 10
    assert c.stt == pytest.approx(sell_value * 0.0015)                       # 16.575
    assert c.stamp == pytest.approx(buy_value * 0.00003)                      # 0.2925
    assert c.exchange == pytest.approx((buy_value + sell_value) * 3553 / 1e7)
    assert c.sebi == pytest.approx((buy_value + sell_value) * 10 / 1e7)
    assert c.gst == pytest.approx(0.18 * (10 + c.exchange + c.sebi))
    # 16.575 STT + 7.390 exchange + 10 brokerage + 3.134 GST + 0.293 stamp + 0.021 SEBI
    assert c.total == pytest.approx(37.41, abs=0.01)


def test_round_trip_either_side_of_2024_10_01():
    # STT and NSE's uniform exchange charge both changed on 2024-10-01; same trade, one day apart.
    before = costs.round_trip(date(2024, 9, 30), "OPT", 150.0, 170.0, 25)
    after = costs.round_trip(date(2024, 10, 1), "OPT", 150.0, 170.0, 25)
    turnover, sell = (150 + 170) * 25, 170 * 25
    assert before.stt == pytest.approx(sell * 0.000625) and after.stt == pytest.approx(sell * 0.001)
    assert before.exchange == pytest.approx(turnover * 5000 / 1e7)
    assert after.exchange == pytest.approx(turnover * 3553 / 1e7)
    assert after.stt - before.stt == pytest.approx(sell * 0.000375)
    assert before.stamp == after.stamp and before.brokerage == after.brokerage


def test_short_round_trip_pays_stt_on_entry():
    c = costs.round_trip(date(2026, 11, 6), "OPT", 150.0, 140.0, 65, long=False)
    assert c.stt == pytest.approx(150 * 65 * 0.0015) and c.stamp == pytest.approx(140 * 65 * 0.00003)


def test_futures_and_half_sebi_fee_period():
    c = costs.order_charges(date(2020, 9, 1), "FUT", "sell", 11500.0, 75, brokerage_per_order=20)
    v = 11500 * 75
    assert c.stt == pytest.approx(v * 0.0001) and c.stamp == 0
    assert c.sebi == pytest.approx(v * 5 / 1e7)
    assert c.exchange == pytest.approx(v * 190 / 1e7)


def test_exercise_stt():
    assert costs.exercise_stt(date(2026, 11, 9), 40.0, 65) == pytest.approx(40 * 65 * 0.0015)
    assert costs.exercise_stt(date(2025, 11, 4), 40.0, 75) == pytest.approx(40 * 75 * 0.00125)
    assert costs.exercise_stt(date(2026, 11, 9), -5.0, 65) == 0


def test_bad_inputs():
    with pytest.raises(ValueError):
        costs.order_charges(date(2026, 11, 6), "EQ", "buy", 1.0, 1)
    with pytest.raises(ValueError):
        costs.order_charges(date(2026, 11, 6), "OPT", "long", 1.0, 1)
