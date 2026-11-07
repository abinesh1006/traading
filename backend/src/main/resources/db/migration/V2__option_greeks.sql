-- Implied volatility and Greeks per option per day, and a daily volatility summary.
-- Computed by the Python analytics step (niftyquant derive, module greeks.py) from fo_eod closes:
-- Black-76 on the put-call-parity forward of each expiry, r = RBI repo rate.

create table option_greeks (
    trade_date      date not null,
    expiry          date not null,
    strike          double precision not null,
    option_type     text not null check (option_type in ('CE', 'PE')),
    days_to_expiry  integer not null,
    rate            double precision not null,
    forward         double precision,
    forward_source  text not null,
    price           double precision,
    iv_pct          double precision,
    delta           double precision,
    gamma           double precision,
    theta           double precision,
    vega            double precision,
    primary key (trade_date, expiry, strike, option_type)
);
comment on table option_greeks is
    'IV and Greeks for every Nifty option with days_to_expiry > 0; NULL IV where the option did not trade';
comment on column option_greeks.rate is 'RBI repo rate used, decimal (0.055 = 5.5%)';
comment on column option_greeks.forward is 'Forward for the expiry: put-call parity (forward_source parity), else futures, else spot';
comment on column option_greeks.price is 'NSE closing price, only when the option traded';
comment on column option_greeks.iv_pct is 'Implied volatility, % a year';
comment on column option_greeks.delta is 'Per 1 point of the forward (futures delta)';
comment on column option_greeks.gamma is 'Change in delta per 1 point';
comment on column option_greeks.theta is 'Index points per calendar day';
comment on column option_greeks.vega is 'Index points per 1 volatility point';

create table iv_daily (
    trade_date    date primary key,
    near_expiry   date,
    near_atm_iv   double precision,
    near_forward  double precision,
    next_expiry   date,
    next_atm_iv   double precision,
    iv_30d        double precision,
    skew_expiry   date,
    skew_atm_iv   double precision,
    iv_25d_put    double precision,
    iv_25d_call   double precision,
    rr_25d        double precision,
    bf_25d        double precision,
    vix_close     double precision,
    rv_20d        double precision
);
comment on table iv_daily is 'Daily Nifty volatility summary; all IVs in % a year';
comment on column iv_daily.iv_30d is '30-day constant-maturity ATM IV from monthly expiries (comparable to India VIX)';
comment on column iv_daily.rr_25d is '25-delta risk reversal: put IV minus call IV on the first expiry >= 7 days out';
comment on column iv_daily.bf_25d is '25-delta butterfly: average of 25-delta put and call IV minus ATM IV';
comment on column iv_daily.rv_20d is 'Realised volatility, 20 sessions of Nifty close-to-close log returns, annualised';
