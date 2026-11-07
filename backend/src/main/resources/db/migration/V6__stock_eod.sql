-- Stock-level end-of-day data for result and event studies (Python module stocks.py, `niftyquant stocks`).
-- Loaded per day by `niftyquant pg-load`, like fo_eod.

create table stock_eod (
    trade_date     date not null,
    symbol         text not null,
    series         text not null check (series in ('EQ', 'BE')),
    isin           text,
    open           double precision,
    high           double precision,
    low            double precision,
    close          double precision,
    last           double precision,
    prev_close     double precision,
    volume_shares  bigint,
    turnover_inr   double precision,
    trades         bigint,
    primary key (trade_date, symbol, series)
);
comment on table stock_eod is 'NSE cash-market bhavcopy: every equity in series EQ and BE, one row per stock per day';
comment on column stock_eod.prev_close is
    'NSE''s previous close, adjusted for corporate actions on the ex-date: close / prev_close - 1 is the day''s return';
comment on column stock_eod.turnover_inr is 'Rupees traded';
-- One stock's history.
create index stock_eod_symbol_idx on stock_eod (symbol, trade_date);

-- Same columns, constraints and indexes as fo_eod (stock futures and options instead of Nifty's).
create table stock_fo_eod (like fo_eod including all);
comment on table stock_fo_eod is
    'NSE F&O bhavcopy, stock futures and options for the Nifty heavyweights (stocks.UNIVERSE), one row per contract per day';
