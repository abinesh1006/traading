"""Parse NSE end-of-day files into tidy DataFrames with a stable schema.

F&O bhavcopy units (verified against both formats, 2026-11-07):
- volume_contracts: number of contracts traded.
- oi_units / oi_change_units: open interest in units (index quantity), not contracts.
- turnover_inr: notional value. For options this is (strike + premium) x quantity,
  not premium paid.
"""

import io
import re
import zipfile
from datetime import date, datetime

import numpy as np
import pandas as pd

FO_COLUMNS = [
    "trade_date", "symbol", "instrument", "expiry", "strike", "option_type",
    "open", "high", "low", "close", "last", "prev_close", "settle", "underlying",
    "volume_contracts", "oi_units", "oi_change_units", "turnover_inr", "trades",
    "lot_size", "lot_size_source", "contract_id", "source_format",
]

_FLOAT = ["strike", "open", "high", "low", "close", "last", "prev_close", "settle",
          "underlying", "turnover_inr"]
_INT = ["volume_contracts", "oi_units", "oi_change_units"]
_NULLABLE_INT = ["trades", "lot_size", "contract_id"]
_STR = ["symbol", "instrument", "option_type", "lot_size_source", "source_format"]
STR_DTYPE = pd.StringDtype(na_value=np.nan)


class ParseError(ValueError):
    pass


def _read_zipped_csv(raw: bytes) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if len(names) != 1:
            raise ParseError(f"expected one csv in zip, found {z.namelist()}")
        df = pd.read_csv(z.open(names[0]), dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    return df.loc[:, [c for c in df.columns if c and not c.startswith("Unnamed")]]


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.str.strip().replace({"": None, "-": None}), errors="coerce")


def _fo_dtypes(out: pd.DataFrame) -> pd.DataFrame:
    for c in _FLOAT:
        out[c] = out[c].astype("float64")
    for c in _INT:
        out[c] = out[c].fillna(0).astype("int64")
    for c in _NULLABLE_INT:
        out[c] = out[c].astype("Int64")
    for c in _STR:
        out[c] = out[c].astype(STR_DTYPE)
    return out


def _finish_fo(out: pd.DataFrame, trade_date: date) -> pd.DataFrame:
    out = _fo_dtypes(out)
    out["trade_date"] = trade_date
    out = out[FO_COLUMNS].sort_values(["instrument", "expiry", "strike", "option_type"],
                                      na_position="first")
    return out.reset_index(drop=True)


def parse_fo_udiff(raw: bytes, trade_date: date, symbols: tuple[str, ...]) -> pd.DataFrame:
    df = _read_zipped_csv(raw)
    dates = set(df["TradDt"].unique())
    if dates != {trade_date.isoformat()}:
        raise ParseError(f"file trade dates {dates} != requested {trade_date}")
    df = df[df["FinInstrmTp"].isin(["IDF", "IDO"]) & df["TckrSymb"].isin(symbols)]
    out = pd.DataFrame({
        "symbol": df["TckrSymb"],
        "instrument": np.where(df["FinInstrmTp"] == "IDF", "FUT", "OPT"),
        "expiry": pd.to_datetime(df["XpryDt"], format="%Y-%m-%d").dt.date,
        "strike": _num(df["StrkPric"]),
        "option_type": df["OptnTp"].str.strip().replace({"": None}),
        "open": _num(df["OpnPric"]), "high": _num(df["HghPric"]),
        "low": _num(df["LwPric"]), "close": _num(df["ClsPric"]),
        "last": _num(df["LastPric"]), "prev_close": _num(df["PrvsClsgPric"]),
        "settle": _num(df["SttlmPric"]), "underlying": _num(df["UndrlygPric"]),
        "volume_contracts": _num(df["TtlTradgVol"]),
        "oi_units": _num(df["OpnIntrst"]), "oi_change_units": _num(df["ChngInOpnIntrst"]),
        "turnover_inr": _num(df["TtlTrfVal"]), "trades": _num(df["TtlNbOfTxsExctd"]),
        "lot_size": _num(df["NewBrdLotQty"]), "lot_size_source": "exchange",
        "contract_id": _num(df["FinInstrmId"]), "source_format": "udiff",
    })
    return _finish_fo(out, trade_date)


def parse_fo_legacy(raw: bytes, trade_date: date, symbols: tuple[str, ...]) -> pd.DataFrame:
    df = _read_zipped_csv(raw)
    dates = {datetime.strptime(t.strip(), "%d-%b-%Y").date() for t in df["TIMESTAMP"].unique()}
    if dates != {trade_date}:
        raise ParseError(f"file trade dates {dates} != requested {trade_date}")
    df = df[df["INSTRUMENT"].isin(["FUTIDX", "OPTIDX"]) & df["SYMBOL"].isin(symbols)]
    is_fut = df["INSTRUMENT"] == "FUTIDX"
    out = pd.DataFrame({
        "symbol": df["SYMBOL"],
        "instrument": np.where(is_fut, "FUT", "OPT"),
        "expiry": pd.to_datetime(df["EXPIRY_DT"].str.strip(), format="%d-%b-%Y").dt.date,
        "strike": _num(df["STRIKE_PR"]).where(~is_fut),
        "option_type": df["OPTION_TYP"].str.strip().where(~is_fut, None),
        "open": _num(df["OPEN"]), "high": _num(df["HIGH"]),
        "low": _num(df["LOW"]), "close": _num(df["CLOSE"]),
        "last": np.nan, "prev_close": np.nan,
        "settle": _num(df["SETTLE_PR"]), "underlying": np.nan,
        "volume_contracts": _num(df["CONTRACTS"]),
        "oi_units": _num(df["OPEN_INT"]), "oi_change_units": _num(df["CHG_IN_OI"]),
        "turnover_inr": _num(df["VAL_INLAKH"]) * 1e5,
        "trades": pd.NA, "lot_size": pd.NA, "lot_size_source": None,
        "contract_id": pd.NA, "source_format": "legacy",
    })
    out = _finish_fo(out, trade_date)
    return derive_lot_sizes(out)


def derive_lot_sizes(df: pd.DataFrame) -> pd.DataFrame:
    """Infer lot size where the file does not state it.

    turnover = contracts x lot x average traded price. For options the average price
    is (strike + premium) and the strike dominates, so the median over an expiry's
    traded options is exact to well under one unit. For futures, the close can sit
    1-2% away from the average traded price, which is not precise enough
    (65 vs 64), so futures are used only when nothing else is available.
    """
    df = df.copy()
    traded = df["volume_contracts"] > 0
    is_opt = df["instrument"] == "OPT"
    ref_price = np.where(is_opt, df["strike"] + df["close"], df["close"])
    est = pd.Series(df["turnover_inr"] / (df["volume_contracts"] * ref_price), index=df.index)
    est = est.where(traded & np.isfinite(est) & (est > 0))
    keys = [df["symbol"], df["expiry"]]

    opt_est = est.where(is_opt)
    opt_count = opt_est.groupby(keys).transform("count")
    lots = opt_est.groupby(keys).transform("median").where(opt_count >= 3).round()
    # Expiries without enough traded options: most common option-derived lot that day.
    day_mode = lots.groupby(df["symbol"]).transform(
        lambda s: s.mode().iloc[0] if s.notna().any() else np.nan)
    lots = lots.fillna(day_mode)
    # Last resort: futures-based estimate.
    lots = lots.fillna(est.groupby(keys).transform("median").round())

    missing = df["lot_size"].isna() & lots.notna()
    df.loc[missing, "lot_size"] = lots[missing].astype("int64")
    df.loc[missing, "lot_size_source"] = "derived"
    return _fo_dtypes(df)


_TITLE_DATE = re.compile(r"as on\s+([A-Za-z]+)\.?\s+(\d{1,2})\s*,?\s*(\d{4})")
_TITLE_MONTH_DAY = re.compile(r"as on\s+([A-Za-z]+)\.?\s+(\d{1,2})\b")


def _snake(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _check_title_date(title: str, trade_date: date) -> None:
    """Verify the 'as on <date>' in a participant file's title matches the requested day.

    Formats seen 2015-2026: "Nov 06, 2026", "Jul 10,2024", "February 11, 2019",
    "Aug 05 2019", May 09,"2024" (followed by stray quote runs), "Sep 17 2019,2019",
    "Jun 08" (no year), and one
    2018 file with no title line at all. When the year is absent, month and day must match;
    when the whole title is absent, the date in the file name is the only evidence.
    """
    if title.lstrip('"').startswith("Client Type"):
        return
    clean = title.replace('"', "").replace("'", "")
    m = _TITLE_DATE.search(clean)
    if m:
        month, day, year = m.groups()
        file_date = datetime.strptime(f"{month[:3]} {day} {year}", "%b %d %Y").date()
        if file_date != trade_date:
            raise ParseError(f"file date {file_date} != requested {trade_date}")
        return
    m = _TITLE_MONTH_DAY.search(clean)
    if m:
        month, day = m.groups()
        md = datetime.strptime(f"{month[:3]} {day} 2000", "%b %d %Y").date()
        if (md.month, md.day) != (trade_date.month, trade_date.day):
            raise ParseError(f"file month/day {md:%m-%d} != requested {trade_date}")
        return
    raise ParseError(f"no 'as on <date>' in title: {title[:200]!r}")


def parse_participant(raw: bytes, trade_date: date) -> pd.DataFrame:
    """Participant-wise OI or volume (contracts) for Client, DII, FII, Pro and TOTAL."""
    lines = raw.decode("utf-8-sig", errors="replace").splitlines()
    if not lines:
        raise ParseError("empty participant file")
    _check_title_date(lines[0], trade_date)
    header = next(i for i, line in enumerate(lines) if line.lstrip('"').startswith("Client Type"))
    df = pd.read_csv(io.StringIO("\n".join(lines[header:])), dtype=str, keep_default_na=False)
    df.columns = [_snake(c) for c in df.columns]
    df = df.loc[:, [c for c in df.columns if c and not c.startswith("unnamed")]]
    df = df[df["client_type"].str.strip() != ""].copy()
    df["client_type"] = df["client_type"].str.strip()
    for c in df.columns.drop("client_type"):
        # Usually plain integers; one 2019 file writes "80,776.00".
        values = pd.to_numeric(df[c].str.strip().str.replace(",", "", regex=False), errors="raise")
        if not (values == values.round()).all():
            raise ParseError(f"non-integer contract counts in column {c}")
        df[c] = values.astype("int64")
    df.insert(0, "trade_date", trade_date)
    expected = {"Client", "DII", "FII", "Pro", "TOTAL"}
    if set(df["client_type"]) != expected:
        raise ParseError(f"client types {set(df['client_type'])} != {expected}")
    return df.reset_index(drop=True)


INDEX_COLUMNS = {
    "Index Name": "index_name", "Index Date": "trade_date",
    "Open Index Value": "open", "High Index Value": "high", "Low Index Value": "low",
    "Closing Index Value": "close", "Points Change": "points_change", "Change(%)": "change_pct",
    "Volume": "volume", "Turnover (Rs. Cr.)": "turnover_cr", "P/E": "pe", "P/B": "pb",
    "Div Yield": "div_yield",
}


# Old index names mapped to current ones so a series is continuous. Verified in the archive:
# "CNX Nifty" appears up to 2015-11-06 and "Nifty 50" from 2015-11-09, never both on one day.
INDEX_RENAMES = {"CNX Nifty": "Nifty 50"}

# Seen: 06-11-2026 (usual), 24/03/2015 (early 2015), and month-first 04-06-2023 for 2023-04-06.
_INDEX_DATE_FORMATS = ("%d-%m-%Y", "%d/%m/%Y", "%m-%d-%Y", "%m/%d/%Y", "%d-%b-%Y")


def _check_index_dates(values: pd.Series, trade_date: date) -> None:
    """Accept the file only if some known date format reads every row as the requested day."""
    s = values.str.strip()
    for fmt in _INDEX_DATE_FORMATS:
        parsed = pd.to_datetime(s, format=fmt, errors="coerce")
        if parsed.notna().all() and set(parsed.dt.date) == {trade_date}:
            return
    raise ParseError(f"index file dates {sorted(set(s))[:3]} do not match requested {trade_date}")


def parse_index_close(raw: bytes, trade_date: date) -> pd.DataFrame:
    """Daily OHLC for every NSE index (Nifty 50, India VIX, sector indices, ...)."""
    df = pd.read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    missing = set(INDEX_COLUMNS) - set(df.columns)
    if missing:
        raise ParseError(f"index file missing columns {missing}")
    df = df[list(INDEX_COLUMNS)].rename(columns=INDEX_COLUMNS)
    df["index_name"] = df["index_name"].str.strip().replace(INDEX_RENAMES)
    df = df[df["index_name"] != ""]
    _check_index_dates(df["trade_date"], trade_date)
    df["trade_date"] = trade_date
    for c in df.columns.drop(["index_name", "trade_date"]):
        df[c] = _num(df[c]).astype("float64")
    # NSE sometimes repeats an index row verbatim; keep one.
    df = df.drop_duplicates().drop_duplicates(subset="index_name", keep="first")
    return df.reset_index(drop=True)
