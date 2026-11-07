-- Quarterly results study of the Nifty heavyweights (Python modules stockiv.py, nifty_weights.py,
-- results.py; `niftyquant derive`). All five tables are replaced in full by each pg-load.

create table stock_iv (
    trade_date            date not null,
    symbol                text not null,
    expiry                date not null,
    days_to_expiry        integer not null,
    spot                  double precision,
    fut_close             double precision,
    forward               double precision,
    forward_source        text,
    atm_iv                double precision,
    atm_strike            double precision,
    atm_straddle          double precision,
    straddle_pct          double precision,
    opt_volume_contracts  bigint,
    opt_oi_units          bigint,
    primary key (trade_date, symbol, expiry)
);
comment on table stock_iv is 'Daily ATM implied volatility, forward and straddle per heavyweight stock, first three expiries';
comment on column stock_iv.atm_iv is 'Black-76 IV (%) at strike = forward, interpolated across liquid OTM strikes';
comment on column stock_iv.straddle_pct is 'Call + put close at the traded strike nearest the forward, % of forward';
create index stock_iv_symbol_idx on stock_iv (symbol, trade_date);

create table nifty_weights (
    trade_date    date not null,
    symbol        text not null,
    weight_pct    double precision,
    points        double precision,
    window_start  date not null,
    primary key (trade_date, symbol)
);
comment on table nifty_weights is
    'Estimated Nifty 50 weight of each heavyweight at the close, and the index points it added that day';
comment on column nifty_weights.window_start is 'Fit window (nifty_weight_fits) the weight comes from';

create table nifty_weight_fits (
    window_start             date primary key,
    window_end               date not null,
    obs                      integer not null,
    outlier_days             integer not null,
    candidates               integer not null,
    members_found            integer not null,
    residual_sd_points       double precision,
    max_abs_residual_points  double precision,
    weight_sum_pct           double precision
);
comment on table nifty_weight_fits is
    'One row per fit window: how well the estimated weights reproduce the daily Nifty move';
comment on column nifty_weight_fits.residual_sd_points is 'Index points per day the fitted members do not explain';

create table result_events (
    symbol                   text not null,
    quarter                  text not null,
    quarter_end              date not null,
    reaction_session         date not null,
    pre_session              date,
    source                   text not null check (source in ('confirmed', 'inferred')),
    inferred_session         date,
    iv_drop_pts              double precision,
    market_iv_drop_pts       double precision,
    idio_iv_drop_pts         double precision,
    detect_score             double precision,
    detect_margin            double precision,
    pre_close                double precision,
    gap_pct                  double precision,
    return_pct               double precision,
    drift_3d_pct             double precision,
    pre_drift_5d_pct         double precision,
    implied_move_pct         double precision,
    straddle_pct             double precision,
    surprise                 double precision,
    iv_pre                   double precision,
    iv_post                  double precision,
    beta                     double precision,
    nifty_return_pct         double precision,
    abnormal_return_pct      double precision,
    volume_ratio             double precision,
    nifty_iv30_change        double precision,
    nifty_weight_pct         double precision,
    nifty_move_points        double precision,
    nifty_points             double precision,
    nifty_abnormal_points    double precision,
    share_of_nifty_move_pct  double precision,
    primary key (symbol, quarter)
);
comment on table result_events is
    'One row per heavyweight quarterly result: what options priced in, how the stock and Nifty reacted';
comment on column result_events.reaction_session is
    'First session that could trade on the result (same day if released in market hours, else next)';
comment on column result_events.source is 'confirmed: from news reports; inferred: largest idiosyncratic IV drop in the SEBI window';
comment on column result_events.implied_move_pct is 'Event one-day standard deviation priced in at the pre_session close';
comment on column result_events.surprise is '|return_pct| / implied_move_pct';
comment on column result_events.nifty_points is 'Nifty points the stock added on the reaction session (weight x move)';
create index result_events_session_idx on result_events (reaction_session);

create table result_summary (
    symbol                    text primary key,
    announcements             integer not null,
    median_abs_move_pct       double precision,
    median_implied_move_pct   double precision,
    beat_implied_share        double precision,
    median_abs_abnormal_pct   double precision,
    median_iv_drop_pts        double precision,
    up_share                  double precision,
    drift_follows_share       double precision,
    median_abs_nifty_points   double precision,
    max_abs_nifty_points      double precision,
    median_nifty_weight_pct   double precision
);
comment on table result_summary is 'Per heavyweight (plus ALL): results moves against what options priced in';
