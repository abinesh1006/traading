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
