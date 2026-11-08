# niftyquant

Python side of the Nifty quant app: data ingestion now; features, models and research later.

## Setup

```
cd F:\trading\quant
uv venv --python C:\Python313\python.exe .venv
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
.venv\Scripts\python.exe -m pytest
```

## Commands

```
niftyquant backfill --start 2015-01-01 --end today   # resumable; finished days are skipped
niftyquant update                                     # daily job: last 10 days + derive + quality
niftyquant macro                                      # Brent, WTI, USD/INR daily, full history (also run by update)
niftyquant fpi                                        # FII/FPI equity cash flows from NSDL, monthly, resumable (also run by update)
niftyquant fiidii                                     # save tonight's NSE provisional FII + DII (also run by update)
niftyquant premiums [--date D] [--steps 5]            # ITM/ATM/OTM call and put premiums around spot, one day
niftyquant status                                     # what is downloaded, what is pending/missing
niftyquant quality                                    # data checks; report in data/reports/
niftyquant derive [--full]                            # rebuild summary tables for the API (incremental)
niftyquant stocks [--start 2018-01-01]                # stock closes (all NSE equities) + heavyweight stock F&O, resumable (also run by update)
niftyquant results [--full]                           # stock IV, Nifty weights and the quarterly results study; prints a summary
niftyquant pg-load [--datasets ...] [--reload]        # copy new or re-fetched days and derived tables into Postgres (also run by update)
niftyquant pg-status                                  # what is loaded in Postgres
niftyquant serve                                      # research API on 127.0.0.1:8001 for the backend
```

The executable is `.venv\Scripts\niftyquant.exe`.

## Datasets (NSE public archives, free)

| Dataset | Content | Since |
|---|---|---|
| `fo_bhavcopy` | End-of-day Nifty futures and every option contract: OHLC, settle, OI, volume, turnover, lot size | 2015 |
| `index_close` | Daily OHLC for every NSE index, including Nifty 50 and India VIX; P/E, P/B, dividend yield | 2015 |
| `participant_oi` | Open interest by Client, DII, FII, Pro (index/stock futures and options, long/short) | 2015 |
| `participant_vol` | Same split for traded volume | 2015 |

Stored as `data/curated/nse/<dataset>/year=YYYY/YYYY-MM-DD.parquet` (one file per trading day).
Every fetch is logged in `data/manifest.sqlite` with status `ok`, `holiday`, `pending`, `missing` or `error`;
everything except `ok` and `holiday` is retried on the next run.

## Crude oil and rupee (FRED, free)

`data/curated/fred/macro_daily.parquet`, long format (`obs_date, series, value, unit, fred_id`):

| series | FRED id | Unit | Since |
|---|---|---|---|
| `brent` | `DCOILBRENTEU` | USD/barrel (EIA spot) | 1987 |
| `wti` | `DCOILWTICO` | USD/barrel (EIA spot) | 1986 |
| `usdinr` | `DEXINUS` | INR per USD (Fed noon New York rate); up means a weaker rupee | 1973 |

The whole file is replaced on each run because past values get revised.

- **Timing.** A value dated D is set after NSE closes on D, so it can only explain Nifty from the
  next session. Join it with `macro.align_to_sessions(...)`, never on equal dates.
- **Lag.** FRED posts crude a few days late and the rupee up to about a week late. It's fine for
  research but can't be used live.
- WTI was negative on 2020-04-20. That is real, not an error.

## FII/FPI cash flows (NSDL, free)

`data/curated/nsdl/fpi_equity/year=YYYY/YYYY-MM.parquet`: one row per NSDL reporting date, equity only.
`exch_*` is buying and selling on stock exchanges, `primary_net_cr` is IPO and other primary buying, and
`equity_*` is both together. Amounts are Rs crore. The FII futures and options positions are in `participant_oi`.

- **Timing.** NSDL's reporting date D holds custodian-confirmed trades from the session *before* D,
  published on D. Use it only from the session after D, matching on dates strictly before the
  session (as `macro.align_to_sessions` does).
- **Not the NSE number.** NSE's same-evening provisional FII/DII figures differ and NSE keeps no
  history of them. NSDL has no DII data.
- NSDL blocks Python's HTTP stack, so the download uses the `curl` executable. Every month is
  checked against NSDL's own month total.

## NSE provisional FII/DII (recorded daily from 2026-11-06)

`data/curated/nse/fii_dii_provisional/`: NSE's same-evening FII and DII cash buy, sell and net (Rs crore).
NSE serves only the latest day and keeps no history, so the 8 pm scheduled `update` saves it each
evening. An evening the PC is off is lost for good, and `quality` lists such days as `fii_dii_missed_days`.

## India VIX, IV and premiums by strike

- India VIX open, high, low and close come from the all-indices file (`index_close`, since 2015)
  and appear as `vix_*` in `derived/daily_market.parquet`.
- `derived/option_greeks/` holds IV and Greeks for every traded option every day, and `derived/iv_daily.parquet`
  holds ATM IV, 30-day IV and skew (see `greeks.py`).
- `derived/moneyness_daily.parquet` covers the nearest expiry, ATM ±10 strikes, calls and puts:
  premium, intrinsic, time value, IV, delta, VIX, and the same contract's next-session close.
  `steps_itm` is +n for in the money, 0 for at the money and -n for out of the money, with 50-point steps.
- **All of this is end of day** (closing prices). Premiums at a time of day need minute-level option
  history (Fyers).

## Events, stocks and quarterly results

- **Events** (`events.py`, `derived/market_events.parquet`, `event_impact.parquet`): RBI policy, FOMC,
  US CPI, budgets, elections, special sessions, expiries and big-move days since 2015, each with the
  first NSE session that could react (`reaction_session`; US events land after the Indian close) and
  Nifty's move against the one-day move options priced the session before. `event_time_ist` is the
  scheduled time where it is fixed by rule (FOMC 14:00 New York, in IST through US daylight saving).
- **Stocks** (`stocks.py`): `cm_bhavcopy` is the cash-market close of every NSE equity (series EQ/BE)
  and `fo_stock` the stock futures and options of the 15 heavyweights in `stocks.UNIVERSE`, both
  since 2018 from the same NSE archive. Compute returns with `stocks.adjust()` (see below).
- **Stock IV** (`stockiv.py`, `derived/stock_iv.parquet`): ATM IV, parity forward and ATM straddle per
  heavyweight and expiry, first three expiries, by the same method as the Nifty Greeks.
- **Nifty weights** (`nifty_weights.py`, `derived/nifty_weights.parquet`, fit quality in
  `nifty_weight_fits.parquet`): estimated from prices alone. The index's daily change in points is a
  fixed combination of its members' price changes between reconstitutions, so a non-negative least
  squares fit per half-year recovers each member's weight; it reproduces the index within about a
  point a day. `points` is the Nifty points a stock added that day.
- **Quarterly results** (`results.py`, `derived/result_events.parquet`, `result_summary.parquet`):
  one row per heavyweight result. The reaction session is confirmed from news reports where checked
  (`results.CONFIRMED`), else inferred from the collapse in the stock's ATM IV inside the SEBI
  reporting window (`results.validate()` scores it against the confirmed ones; it does not work for
  HDFC Bank, whose IV barely reacts). Per result: the move options priced the evening before
  (two-expiry term structure), the actual gap, move and 3-day drift, the move beyond Nifty (beta),
  the IV crush, and the Nifty points it moved the index. No consensus estimates: those need a paid feed.

## Live view (Fyers)

`GET /live` (backend: `/api/live`, `live.py`) says whether NSE is open right now (pre-open 09:00,
trading 09:15 to the 15:40 F&O close, weekends, `live.HOLIDAYS`, special sessions such as Diwali
Muhurat) and gives Nifty 50, India VIX and the near-month Nifty future: live from Fyers when
logged in, otherwise the last end-of-day close, marked `source: close`.

One-time setup:

1. Install the feed's dependencies, then the Fyers SDK without its own (it hard-pins old `requests`,
   `aiohttp` and the obsolete `asyncio` backport, which break this environment):
   `uv pip install --python .venv\Scripts\python.exe -e ".[live]"` and
   `uv pip install --python .venv\Scripts\python.exe --no-deps fyers-apiv3==3.2.1`
2. In the Fyers API dashboard, set the app's redirect URL to
   `http://127.0.0.1:8001/live/fyers/callback` (or set `FYERS_REDIRECT_URI` in `.env` to whatever is
   registered; it must point at this API's `/live/fyers/callback`).
3. `FYERS_APP_ID` and `FYERS_SECRET_KEY` in `.env`.

Every trading day: open `http://127.0.0.1:8001/live/fyers/login` (the dashboard's Connect button)
and log in to Fyers. The access token is kept in `data/secrets/fyers_token.json` and expires at
06:30 IST. Prices stream over Fyers' data WebSocket. The REST data API is not polled: the Standard
plan allows 50 requests a minute and 5,000 a day, and going over the per-minute limit 3 times
blocks the account for the day. Add next year's NSE holidays to `live.HOLIDAYS` each December;
`/live` says so in `calendar_note` once the list runs out.

## Things that are easy to get wrong

- **Units.** `volume_contracts` is contracts; `oi_units` is units, not contracts. `turnover_inr` for
  options is notional, (strike + premium) x quantity, not premium paid.
- **Two formats.** NSE switched the F&O bhavcopy to UDiFF on 2024-07-08. Both parse to one schema.
  The legacy file has no lot size, last price, underlying price or trade count; lot size is
  derived from turnover (`lot_size_source = "derived"`), which reproduces the exchange lot exactly
  where both are available.
- **Expiries come from the data.** Expiry days move for holidays (e.g. Monday 2026-11-09 and
  2026-11-23) and NSE changed the weekly expiry weekday over the years. Never compute them from a rule.
- **Trading calendar comes from the data.** A day is a trading day if NSE published its files,
  which also catches special weekend sessions.
- **Every file's own date is checked** against the requested date, so a wrong file is never stored.
- **NSE's prev_close is not adjusted for splits and bonuses** in the cash-market bhavcopy (HDFC Bank
  1964.10 -> 973.40 on its 2025-08-26 bonus ex-date), though it is for demergers. `stocks.adjust()`
  finds split/bonus days and gives `adj_prev_close`; never compute stock returns from `prev_close`.
- **NSE's archive has no F&O bhavcopy for 2021-03-30**, a trading day (the index-close file exists),
  so trading days come from the index-close files, not the F&O files.
- **Stock F&O is not Nifty F&O.** `fo_bhavcopy` keeps index contracts only; stock contracts are in
  `fo_stock`, for `stocks.UNIVERSE` only.
