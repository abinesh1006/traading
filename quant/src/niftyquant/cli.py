"""Command line: niftyquant backfill | update | premiums | fiidii | macro | fpi | status | quality | derive | pg-load | pg-status | serve"""

import argparse
import json
import logging
from datetime import date, datetime, timedelta

import pandas as pd

from . import config, quality
from .ingest import ALL_DATASETS, ingest_range
from .store import Manifest


def _date(s: str) -> date:
    return date.today() if s == "today" else date.fromisoformat(s)


def cmd_backfill(a) -> None:
    res = ingest_range(a.start, a.end, a.datasets, force=a.force)
    if not res.empty:
        print(res.groupby(["dataset", "result"]).size().unstack(fill_value=0).to_string())


def cmd_update(a) -> None:
    """Daily job: fetch recent days, refresh derived tables, re-run quality checks."""
    a.start, a.end, a.force = date.today() - timedelta(days=a.days), date.today(), False
    cmd_backfill(a)
    try:
        print()
        cmd_fiidii(a)
    except Exception as e:  # NSE serves only the latest day, so a miss here is lost for good
        logging.getLogger("niftyquant").error("NSE FII/DII provisional download failed: %s", e)
    try:
        print()
        cmd_macro(a)
    except Exception as e:  # NSE data is already saved; the quality check flags stale series
        logging.getLogger("niftyquant").error("FRED download failed: %s", e)
    try:
        print()
        a.start, a.force = date.today() - timedelta(days=45), False
        cmd_fpi(a)
    except Exception as e:
        logging.getLogger("niftyquant").error("NSDL FPI download failed: %s", e)
    a.full = False
    cmd_derive(a)
    a.start = a.end = None
    cmd_quality(a)
    from .pgload import PgSettings
    if PgSettings.from_env() is None:
        print("\nPostgres not configured (PG_DB/PG_USER in .env): skipping pg-load")
        return
    a.datasets, a.reload = list(ALL_DATASETS), False
    try:
        print()
        cmd_pg_load(a)
    except Exception as e:  # files and derived tables are updated; report the load failure
        logging.getLogger("niftyquant").error("pg-load failed: %s", e)
        raise SystemExit(1) from e


def cmd_macro(a) -> None:
    from . import macro
    print("FRED daily series (crude oil, USD/INR):")
    print(macro.fetch().to_string())


def cmd_premiums(a) -> None:
    from . import premiums
    d = a.date
    if d is None:
        files = sorted((config.CURATED_DIR / "nse" / "fo_bhavcopy").glob("year=*/*.parquet"))
        d = date.fromisoformat(files[-1].stem)
    t = premiums.show(d, a.steps, a.expiry)
    at = t.attrs
    print(f"{d}  Nifty close {at['spot']:.2f}  India VIX {at['vix']:.2f}  expiry {at['expiry']} "
          f"({at['days_to_expiry']} days)  - end-of-day closing premiums, untraded strikes blank")
    print("steps_itm: +n = n strikes in the money, 0 = at the money, -n = out of the money\n")
    show = t[["ce_steps_itm", "ce_premium", "ce_intrinsic", "ce_time_value", "ce_iv_pct", "ce_delta",
              "strike", "pe_premium", "pe_intrinsic", "pe_time_value", "pe_iv_pct", "pe_delta", "pe_steps_itm"]]
    print(show.to_string(index=False, float_format=lambda v: f"{v:.2f}", na_rep="-"))


def cmd_fiidii(a) -> None:
    from . import fiidii
    df = fiidii.fetch()
    print(f"NSE provisional FII/DII for {df['trade_date'].iloc[0]} (Rs crore):")
    print(df.drop(columns="trade_date").to_string(index=False))


def cmd_fpi(a) -> None:
    from . import nsdl
    res = nsdl.fetch(a.start, force=a.force)
    print("NSDL FPI equity flows:", res["result"].value_counts().to_dict() if not res.empty else "nothing to do")
    bad = res[res["result"] == "error"] if not res.empty else res
    if not bad.empty:
        print("failed months (retried next run):", ", ".join(bad["month"]))
    df = nsdl.read()
    if not df.empty:
        print(f"stored: {len(df)} reporting days, {df['reporting_date'].min()} -> {df['reporting_date'].max()}")


def _pg_settings():
    from .pgload import PgSettings
    s = PgSettings.from_env()
    if s is None:
        raise SystemExit("Postgres is not configured: set PG_DB, PG_USER, PG_PASSWORD (and PG_SSH_HOST) in .env")
    return s


def cmd_pg_load(a) -> None:
    from . import pgload
    for table, n in pgload.load_all(_pg_settings(), a.datasets, reload=a.reload).items():
        per_day = table in pgload.TABLES.values() or table == pgload.GREEKS_TABLE
        print(f"{table}: {n} {'days loaded' if per_day else 'rows'}")


def cmd_pg_status(a) -> None:
    from . import pgload
    df = pgload.status(_pg_settings())
    print("nothing loaded yet" if df.empty else df.to_string(index=False))


def cmd_status(a) -> None:
    m = Manifest().frame()
    if m.empty:
        print("manifest is empty")
        return
    m["year"] = m["trade_date"].dt.year
    print(m.pivot_table(index=["dataset", "year"], columns="status", values="trade_date",
                        aggfunc="count", fill_value=0).to_string())
    open_items = m[~m["status"].isin(["ok", "holiday"])]
    if not open_items.empty:
        print("\nNot final (retried on next run):")
        print(open_items.sort_values("trade_date")[["dataset", "trade_date", "status", "message"]]
              .tail(30).to_string(index=False))


def cmd_quality(a) -> None:
    results = quality.run(a.start, a.end)
    summary = {name: len(df) for name, df in results.items()}
    width = max(map(len, summary))
    for name, n in summary.items():
        print(f"{name:<{width}}  {'PASS' if n == 0 else f'{n} rows'}")
    config.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report = config.REPORTS_DIR / f"quality_{stamp}.json"
    report.write_text(json.dumps({
        "summary": summary,
        "details": {name: json.loads(df.head(200).to_json(orient="records", date_format="iso"))
                    for name, df in results.items()},
    }, indent=1))
    print(f"\nDetails (first 200 rows per check): {report}")


def cmd_derive(a) -> None:
    from . import analytics
    for name, n in analytics.build_derived(full=a.full).items():
        print(f"{name}: {n} rows")


def cmd_serve(a) -> None:
    import uvicorn
    uvicorn.run("niftyquant.api:app", host=a.host, port=a.port, log_level="info")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="niftyquant")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("backfill", help="download a date range")
    b.add_argument("--start", type=_date, default=date(2015, 1, 1))
    b.add_argument("--end", type=_date, default=date.today())
    b.add_argument("--datasets", nargs="+", default=list(ALL_DATASETS), choices=ALL_DATASETS)
    b.add_argument("--force", action="store_true", help="re-download days already done")
    b.set_defaults(func=cmd_backfill)

    u = sub.add_parser("update", help="download the last N days (run daily after 8pm IST)")
    u.add_argument("--days", type=int, default=10)
    u.add_argument("--datasets", nargs="+", default=list(ALL_DATASETS), choices=ALL_DATASETS)
    u.set_defaults(func=cmd_update)

    mc = sub.add_parser("macro", help="download daily Brent, WTI and USD/INR from FRED (full history)")
    mc.set_defaults(func=cmd_macro)

    pr = sub.add_parser("premiums", help="ITM/ATM/OTM premiums around spot for one day (end of day)")
    pr.add_argument("--date", type=_date, default=None, help="default: latest day downloaded")
    pr.add_argument("--steps", type=int, default=5, help="strikes each side of ATM")
    pr.add_argument("--expiry", type=_date, default=None, help="default: nearest expiry")
    pr.set_defaults(func=cmd_premiums)

    fd = sub.add_parser("fiidii", help="save today's NSE provisional FII/DII cash flows (latest day only)")
    fd.set_defaults(func=cmd_fiidii)

    fp = sub.add_parser("fpi", help="download daily FPI/FII equity cash flows from NSDL (resumable)")
    fp.add_argument("--start", type=_date, default=date(2015, 1, 1))
    fp.add_argument("--force", action="store_true", help="re-download months already saved")
    fp.set_defaults(func=cmd_fpi)

    s = sub.add_parser("status", help="summarise the fetch manifest")
    s.set_defaults(func=cmd_status)

    q = sub.add_parser("quality", help="run data quality checks")
    q.add_argument("--start", type=_date, default=None)
    q.add_argument("--end", type=_date, default=None)
    q.set_defaults(func=cmd_quality)

    dv = sub.add_parser("derive", help="update derived daily tables for the API (incremental)")
    dv.add_argument("--full", action="store_true", help="recompute every day")
    dv.set_defaults(func=cmd_derive)

    pl = sub.add_parser("pg-load", help="copy new or re-fetched days and derived tables into Postgres")
    pl.add_argument("--datasets", nargs="+", default=list(ALL_DATASETS), choices=ALL_DATASETS)
    pl.add_argument("--reload", action="store_true", help="re-send every day, not just new ones")
    pl.set_defaults(func=cmd_pg_load)

    ps = sub.add_parser("pg-status", help="summarise what is loaded in Postgres")
    ps.set_defaults(func=cmd_pg_status)

    sv = sub.add_parser("serve", help="run the research API for the backend")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8001)
    sv.set_defaults(func=cmd_serve)

    a = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    pd.set_option("display.width", 200)
    a.func(a)


if __name__ == "__main__":
    main()
