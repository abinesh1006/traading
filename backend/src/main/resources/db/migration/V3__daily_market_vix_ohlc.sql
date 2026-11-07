-- India VIX open/high/low alongside vix_close in daily_market (from the NSE all-indices file,
-- written by the Python analytics step).

alter table daily_market
    add column vix_open double precision,
    add column vix_high double precision,
    add column vix_low  double precision;

comment on column daily_market.vix_open is 'India VIX open, from index_eod';
comment on column daily_market.vix_high is 'India VIX intraday high, from index_eod';
comment on column daily_market.vix_low is 'India VIX intraday low, from index_eod';
