-- Option premium by moneyness: what an ITM / ATM / OTM Nifty option cost at the day's spot.
-- Written by the Python analytics step (niftyquant derive, module premiums.py), replaced in full on each load.
-- Nearest expiry only (the expiry day itself on expiry days), strikes within 10 steps of ATM.

create table moneyness_daily (
    trade_date        date not null,
    expiry            date not null,
    days_to_expiry    integer not null,
    spot              double precision not null,
    atm_strike        double precision not null,
    option_type       text not null check (option_type in ('CE', 'PE')),
    strike            double precision not null,
    steps_itm         integer not null,
    premium           double precision,
    intrinsic         double precision not null,
    time_value        double precision,
    volume_contracts  bigint not null,
    oi_units          bigint not null,
    iv_pct            double precision,
    delta             double precision,
    lot_size          integer,
    vix_close         double precision,
    next_date         date,
    next_premium      double precision,
    next_spot         double precision,
    primary key (trade_date, expiry, strike, option_type)
);
comment on table moneyness_daily is
    'Nearest-expiry Nifty options within 10 strikes of ATM, per day, with the next session''s close of the same contract';
comment on column moneyness_daily.atm_strike is 'Spot close rounded to the nearest 50-point strike';
comment on column moneyness_daily.steps_itm is
    '+n = n strikes (50 points each) in the money, 0 = at the money, -n = out of the money; CE is ITM below spot, PE above';
comment on column moneyness_daily.premium is 'NSE closing price; NULL when the option did not trade that day';
comment on column moneyness_daily.intrinsic is 'Value if exercised at the day''s spot close';
comment on column moneyness_daily.time_value is 'premium - intrinsic; NULL when premium is NULL';
comment on column moneyness_daily.oi_units is 'Open interest in units, not contracts: divide by lot_size';
comment on column moneyness_daily.iv_pct is 'Implied volatility, % a year, from option_greeks';
comment on column moneyness_daily.delta is 'From option_greeks, per 1 point of the forward';
comment on column moneyness_daily.next_date is 'Next trading session; NULL on the latest day loaded';
comment on column moneyness_daily.next_premium is 'Same contract''s closing price on next_date; NULL if untraded or expired';
comment on column moneyness_daily.next_spot is 'Nifty spot close on next_date';

-- Research queries pick one moneyness across many days.
create index moneyness_daily_steps_idx on moneyness_daily (option_type, steps_itm, trade_date);
