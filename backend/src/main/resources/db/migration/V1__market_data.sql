-- End-of-day market data from NSE files, written by the Python loader (`niftyquant pg-load`).
-- Each table mirrors one curated Parquet dataset column for column. Prices are double precision
-- so values round-trip exactly from the Parquet store.

create table trading_calendar (
    trade_date  date primary key,
    is_trading  boolean not null
);
comment on table trading_calendar is
    'From the fetch log: a day is trading if any NSE file exists for it, a holiday if confirmed absent';

create table fo_eod (
    trade_date        date not null,
    symbol            text not null,
    instrument        text not null check (instrument in ('FUT', 'OPT')),
    expiry            date not null,
    strike            double precision,
    option_type       text check (option_type in ('CE', 'PE')),
    open              double precision,
    high              double precision,
    low               double precision,
    close             double precision,
    last              double precision,
    prev_close        double precision,
    settle            double precision,
    underlying        double precision,
    volume_contracts  bigint,
    oi_units          bigint,
    oi_change_units   bigint,
    turnover_inr      double precision,
    trades            bigint,
    lot_size          integer,
    lot_size_source   text,
    contract_id       bigint,
    source_format     text not null,
    constraint fo_eod_contract_day
        unique nulls not distinct (trade_date, symbol, instrument, expiry, strike, option_type),
    constraint fo_eod_fut_or_opt check (
        (instrument = 'FUT' and strike is null and option_type is null)
        or (instrument = 'OPT' and strike is not null and option_type is not null))
);
comment on table fo_eod is 'NSE F&O bhavcopy, Nifty index futures and options, one row per contract per day';
comment on column fo_eod.volume_contracts is 'Contracts traded';
comment on column fo_eod.oi_units is 'Open interest in units, not contracts: divide by lot_size';
comment on column fo_eod.oi_change_units is 'Change in open interest, units';
comment on column fo_eod.turnover_inr is 'Rupees; for options NSE reports notional, (strike + premium) x quantity';
comment on column fo_eod.lot_size_source is
    'exchange: stated in the file; derived: inferred from turnover (files before 2024-07-08)';

-- One contract's history: expiry, strike and type, then date.
create index fo_eod_contract_idx on fo_eod (symbol, expiry, strike, option_type, trade_date);

create table index_eod (
    trade_date     date not null,
    index_name     text not null,
    open           double precision,
    high           double precision,
    low            double precision,
    close          double precision,
    points_change  double precision,
    change_pct     double precision,
    volume         double precision,
    turnover_cr    double precision,
    pe             double precision,
    pb             double precision,
    div_yield      double precision,
    primary key (trade_date, index_name)
);
comment on table index_eod is 'NSE closing values for all indices (Nifty 50, India VIX, ...)';
create index index_eod_name_idx on index_eod (index_name, trade_date);

create table participant_oi (
    trade_date               date not null,
    client_type              text not null check (client_type in ('Client', 'DII', 'FII', 'Pro', 'TOTAL')),
    future_index_long        bigint not null,
    future_index_short       bigint not null,
    future_stock_long        bigint not null,
    future_stock_short       bigint not null,
    option_index_call_long   bigint not null,
    option_index_put_long    bigint not null,
    option_index_call_short  bigint not null,
    option_index_put_short   bigint not null,
    option_stock_call_long   bigint not null,
    option_stock_put_long    bigint not null,
    option_stock_call_short  bigint not null,
    option_stock_put_short   bigint not null,
    total_long_contracts     bigint not null,
    total_short_contracts    bigint not null,
    primary key (trade_date, client_type)
);
comment on table participant_oi is 'NSE participant-wise open interest, contracts, all F&O (not Nifty only)';

create table participant_vol (like participant_oi including all);
comment on table participant_vol is 'NSE participant-wise traded volume, contracts, all F&O (not Nifty only)';

-- Derived daily tables (rebuilt from the tables above by the Python analytics step).
create table daily_market (
    trade_date            date primary key,
    spot_open             double precision,
    spot_high             double precision,
    spot_low              double precision,
    spot_close            double precision,
    nifty_pe              double precision,
    vix_close             double precision,
    fut_close             double precision,
    fut_expiry            date,
    fut_oi_units          bigint,
    fut_volume_contracts  bigint,
    lot_size              integer,
    basis_pct             double precision,
    opt_volume_contracts  bigint,
    ce_oi_units           bigint,
    pe_oi_units           bigint,
    pcr_oi                double precision,
    near_expiry           date,
    days_to_expiry        integer,
    near_ce_oi_units      bigint,
    near_pe_oi_units      bigint,
    near_pcr_oi           double precision,
    max_ce_oi_strike      double precision,
    max_pe_oi_strike      double precision,
    atm_strike            double precision,
    atm_straddle          double precision,
    atm_straddle_pct      double precision,
    spot_return_pct       double precision
);
comment on table daily_market is 'One row per trading day: Nifty spot, VIX, near futures and option-chain summary';

create table participants_daily (
    trade_date          date not null,
    client_type         text not null,
    fut_index_long      bigint,
    fut_index_short     bigint,
    fut_index_net       bigint,
    opt_index_call_net  bigint,
    opt_index_put_net   bigint,
    fut_index_long_pct  double precision,
    primary key (trade_date, client_type)
);

-- What the loader has copied, so each run only sends new or re-fetched days.
create table load_log (
    dataset            text not null,
    trade_date         date not null,
    rows               integer not null,
    source_fetched_at  timestamptz not null,
    loaded_at          timestamptz not null default now(),
    primary key (dataset, trade_date)
);
