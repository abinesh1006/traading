# Nifty Quant

Research, then paper, then live trading for Nifty index futures and options.

```
frontend/  React + Vite dashboard (:5173)       talks only to the backend
backend/   Spring Boot 4, Java 21 (:8080)        the one API; owns the Postgres schema (Flyway)
quant/     Python: data ingestion, research API (:8001), later features and models
data/      downloaded and derived data (not in git)
```

## Run it

Prerequisites: Java 21, Maven, Node 20+, Python venv in `quant/.venv` (see `quant/README.md`).

```
.\dev.ps1            # SSH tunnel to Postgres, then the three services, each in its own window
```

Open http://localhost:5173.

Daily data refresh (after ~20:00 IST, when NSE has published the day's files):

```
cd quant
.venv\Scripts\niftyquant.exe update     # fetch recent days, rebuild derived tables, run quality checks
```

To run it automatically every day at 20:00 IST (and at the next opportunity if the PC was off),
register the scheduled task once from a PowerShell window:

```
powershell -ExecutionPolicy Bypass -File scripts\register_daily_task.ps1
```

Each run writes `data\logs\update_<date>.log` (the newest 60 are kept). `scripts\daily_update.ps1`
is the same job, runnable by hand.

## Postgres

Database `niftyquant` on the dev server, reached through an SSH tunnel (Postgres listens only on the
server's localhost). Settings are the `PG_*` lines in `.env` (gitignored).

- Schema: Flyway migrations in `backend/src/main/resources/db/migration`, applied when the backend starts.
- Data: `niftyquant pg-load` copies new or re-fetched days from the Parquet store, then replaces the
  calendar and derived tables. `update` runs it at the end. It opens its own tunnel if none is running.
- `niftyquant pg-status` shows what is loaded; so does the Data health page.

| Table | Contents |
|---|---|
| `fo_eod` | Nifty futures and options, one row per contract per day (OI in units: divide by `lot_size`) |
| `index_eod` | All NSE index closes, including Nifty 50 and India VIX |
| `participant_oi`, `participant_vol` | FII/DII/Client/Pro positions and volume, all F&O, contracts |
| `option_greeks` | IV, delta, gamma, theta, vega for every Nifty option per day (traded options only get IV) |
| `iv_daily` | ATM IV (near, next, 30-day), 25-delta skew, India VIX, 20-day realised vol |
| `daily_market`, `participants_daily` | Derived daily tables the dashboard charts use |
| `trading_calendar` | Trading days and holidays, from the fetch log |
| `load_log` | What the loader has sent, per dataset and day |

Bulk intraday data (1-minute option bars, ticks) will stay in local Parquet, not Postgres.

## Implied volatility and Greeks

`niftyquant derive` computes them from each option's NSE closing price (`quant/src/niftyquant/greeks.py`):
Black-76 on the forward of each expiry, taken from put-call parity on near-the-money strikes; the rate is
the RBI repo rate (`rates.py`, add new MPC decisions there). Options that did not trade and expiry-day
rows get no IV. Delta is per point of the forward (futures delta), theta per calendar day, vega per vol
point. The 30-day ATM IV uses monthly expiries only, like India VIX; it runs a little below VIX because
VIX also prices the skew.

## Dashboard pages

| Page | Shows |
|---|---|
| Market | Nifty close, India VIX, nearest-expiry put-call ratio, ATM straddle (priced move), futures basis |
| Option chain | End-of-day OI and OI change by strike for any date and expiry, with the full chain table |
| Positioning | FII, DII, Client and Pro index futures long share and net position |
| Data health | Coverage per dataset and year, open items, and data-quality check results |

Every chart has a table view. Themes follow the OS, with a manual toggle.

## Tests

```
cd quant    && .venv\Scripts\python.exe -m pytest
cd backend  && mvn test
cd frontend && npm run build
```

## Not built yet

- Fyers integration: intraday history and the live recorder
- Backtester, features and models, paper trading, Claude integration
