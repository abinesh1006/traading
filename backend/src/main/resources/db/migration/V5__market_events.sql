-- Market event calendar and its measured impact on Nifty (Python module events.py, `niftyquant derive`).
-- Both tables are replaced in full by each pg-load.

create table market_events (
    event_date         date not null,
    event_time_ist     timestamptz,
    category           text not null check (category in ('rbi_policy', 'fomc', 'us_cpi', 'union_budget',
                                                         'election', 'special_session', 'expiry', 'market_shock')),
    name               text not null,
    after_close        boolean not null,
    verified           boolean not null,
    change_bp          integer,
    reaction_session   date,
    nifty_move_pct     double precision,
    vix_change_pct     double precision,
    expected_move_pct  double precision,
    vix_close          double precision,
    surprise           double precision,
    primary key (event_date, category, name)
);
comment on table market_events is
    'RBI, FOMC, US CPI, Budget, elections, special sessions, expiries and big-move days, with Nifty''s reaction';
comment on column market_events.event_date is 'Date in the event''s own time zone (US date for FOMC and CPI)';
comment on column market_events.event_time_ist is 'Scheduled time where fixed by rule; NULL where it varied or is unknown (RBI, shocks)';
comment on column market_events.after_close is 'Lands after the Indian close, so the next NSE session reacts';
comment on column market_events.verified is 'Date confirmed by a source (or, for shocks, cause attributed)';
comment on column market_events.reaction_session is 'First NSE session that could react; NULL if not yet traded';
comment on column market_events.expected_move_pct is 'Previous session nearest-expiry ATM IV / sqrt(252): one-day one-sigma move';
comment on column market_events.surprise is '|nifty_move_pct| / expected_move_pct';
create index market_events_session_idx on market_events (reaction_session);

create table event_impact (
    category               text primary key,
    label                  text not null,
    events                 integer not null,
    median_abs_move_pct    double precision,
    mean_abs_move_pct      double precision,
    p90_abs_move_pct       double precision,
    share_up_pct           double precision,
    median_surprise        double precision,
    median_vix_change_pct  double precision,
    move_vs_normal         double precision
);
comment on table event_impact is 'Per event category: Nifty move on reaction sessions; category all_days is the baseline';
comment on column event_impact.move_vs_normal is 'median |move| on these sessions / median |move| on all sessions';
