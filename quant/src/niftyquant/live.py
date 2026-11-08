"""Live market view: a market clock that says whether NSE is open, and a Fyers feed for live prices.

Market clock. NSE trades on weekdays that are not exchange holidays, plus announced special
sessions (Diwali Muhurat, budget weekends). Normal hours: pre-open 09:00-09:15, then continuous
trading from 09:15 to the close. The F&O close moved from 15:30 to 15:40 on 2026-08-03; the view is
built for Nifty F&O, so that close is used.

Fyers feed. Fyers issues an access token through a browser login, once a day; tokens expire at
06:30 IST. /live/fyers/login sends the browser to Fyers, and Fyers redirects to FYERS_REDIRECT_URI
(this API's /live/fyers/callback) with an auth code. The code is exchanged for the token, which is
kept in data/secrets (gitignored, never logged). Prices then stream over Fyers' data WebSocket,
not the REST quotes API: the Standard plan allows 50 data requests a minute and 5,000 a day, and
going over the per-minute limit more than 3 times blocks the account for the day, so polling
would exhaust it within one session. REST is used once per feed start, to backfill today's
1-minute Nifty bars. Without a token, each quote falls back to the last end-of-day close from
daily_market, labelled as such.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time as clock_time
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from urllib.parse import urlencode, urlsplit
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from . import analytics, config

log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
PRE_OPEN, OPEN = time(9, 0), time(9, 15)
FO_CLOSE_CHANGE = date(2026, 8, 3)

# NSE equity and F&O holidays that fall on weekdays, from 2026-11-08 on. Extend this every December,
# when NSE publishes the next year's list; HOLIDAYS_THROUGH records how far it goes.
HOLIDAYS = {
    date(2026, 11, 10): "Diwali Balipratipada",
    date(2026, 11, 24): "Guru Nanak Jayanti",
    date(2026, 12, 25): "Christmas",
}
HOLIDAYS_THROUGH = date(2026, 12, 31)
# Announced special sessions: (open, close, name). Sources disagreed on 15:30 vs 15:40 for the 2026
# Muhurat close; most gave 15:30.
SPECIAL_SESSIONS = {date(2026, 11, 8): (time(14, 20), time(15, 30), "Diwali Muhurat trading")}

LABELS = {"open": "Market open", "pre_open": "Pre-open", "closed": "Market closed"}


def close_time(d: date) -> time:
    return time(15, 40) if d >= FO_CLOSE_CHANGE else time(15, 30)


def session(d: date) -> tuple[time, time, str] | None:
    """(open, close, name) of the trading session on d, or None if NSE is shut that day."""
    if d in SPECIAL_SESSIONS:
        return SPECIAL_SESSIONS[d]
    if d.weekday() >= 5 or d in HOLIDAYS:
        return None
    return OPEN, close_time(d), "Normal session"


def next_open(now: datetime) -> datetime | None:
    """Start of continuous trading at the next session that has not opened yet."""
    for i in range(15):
        d = now.date() + timedelta(days=i)
        s = session(d)
        if s and (i > 0 or now.time() < s[0]):
            return datetime.combine(d, s[0], IST)
    return None


def market_clock(now: datetime | None = None) -> dict:
    """Open, pre-open or closed right now, with the reason and the next open."""
    now = (now or datetime.now(IST)).astimezone(IST)
    d, t = now.date(), now.time()
    nxt = next_open(now)
    out = {"now": now.isoformat(timespec="seconds"), "session_date": None, "session_name": None,
           "session_open": None, "session_close": None,
           "next_open": nxt.isoformat(timespec="minutes") if nxt else None,
           "calendar_note": None if d <= HOLIDAYS_THROUGH else
           f"NSE holidays are loaded only through {HOLIDAYS_THROUGH}; later holidays show as trading days"}
    s = session(d)
    if s is None:
        state, reason = "closed", f"Holiday: {HOLIDAYS[d]}" if d in HOLIDAYS else "Weekend"
    else:
        o, c, name = s
        out.update(session_date=d.isoformat(), session_name=name, session_open=f"{o:%H:%M}",
                   session_close=f"{c:%H:%M}")
        if o <= t < c:
            state, reason = "open", f"{name}, closes {c:%H:%M}"
        elif d not in SPECIAL_SESSIONS and PRE_OPEN <= t < o:
            state, reason = "pre_open", f"Pre-open; trading starts {o:%H:%M}"
        elif t < o:
            state, reason = "closed", f"{name} opens at {o:%H:%M}"
        else:
            state, reason = "closed", f"Closed for the day at {c:%H:%M}"
    out.update(state=state, label=LABELS[state], reason=reason)
    return out


# ---------------------------------------------------------------- Fyers login and token

FYERS_API = "https://api-t1.fyers.in"
DEFAULT_REDIRECT = "http://127.0.0.1:8001/live/fyers/callback"
TOKEN_EXPIRY = time(6, 30)  # Fyers access tokens expire daily at 06:30 IST
LOGIN_STATE_TTL = 600       # seconds a login link stays valid


class FyersError(RuntimeError):
    pass


@dataclass(frozen=True)
class FyersSettings:
    app_id: str
    secret: str
    redirect_uri: str = DEFAULT_REDIRECT

    @classmethod
    def from_env(cls) -> FyersSettings | None:
        app_id = os.environ.get("FYERS_APP_ID", "").strip()
        secret = os.environ.get("FYERS_SECRET_KEY", "").strip()
        if not app_id or not secret:
            return None
        return cls(app_id, secret, os.environ.get("FYERS_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT)

    @property
    def start_url(self) -> str:
        """This API's login route, on the same host as the redirect (the browser opens it)."""
        u = urlsplit(self.redirect_uri)
        return f"{u.scheme}://{u.netloc}/live/fyers/login"

    @property
    def app_id_hash(self) -> str:
        return hashlib.sha256(f"{self.app_id}:{self.secret}".encode()).hexdigest()

    def auth_header(self, token: str) -> dict:
        return {"Authorization": f"{self.app_id}:{token}"}


_login_states: dict[str, float] = {}


def login_url(s: FyersSettings) -> str:
    """Fyers' login page for this app; `state` is checked on the way back."""
    state = secrets.token_urlsafe(16)
    cutoff = clock_time.time() - LOGIN_STATE_TTL
    for k in [k for k, v in _login_states.items() if v < cutoff]:
        del _login_states[k]
    _login_states[state] = clock_time.time()
    return f"{FYERS_API}/api/v3/generate-authcode?" + urlencode(
        {"client_id": s.app_id, "redirect_uri": s.redirect_uri, "response_type": "code", "state": state})


def take_login_state(state: str | None) -> bool:
    created = _login_states.pop(state or "", None)
    return created is not None and clock_time.time() - created <= LOGIN_STATE_TTL


def exchange_auth_code(s: FyersSettings, code: str, post=requests.post) -> str:
    r = post(f"{FYERS_API}/api/v3/validate-authcode",
             json={"grant_type": "authorization_code", "appIdHash": s.app_id_hash, "code": code}, timeout=20)
    try:
        body = r.json()
    except ValueError:
        body = {}
    if body.get("s") != "ok" or not body.get("access_token"):
        raise FyersError(body.get("message") or f"Fyers returned HTTP {r.status_code}")
    return body["access_token"]


def token_path():
    return config.DATA_DIR / "secrets" / "fyers_token.json"


def last_expiry(now: datetime) -> datetime:
    boundary = datetime.combine(now.astimezone(IST).date(), TOKEN_EXPIRY, IST)
    return boundary if now >= boundary else boundary - timedelta(days=1)


def save_token(token: str, now: datetime | None = None) -> None:
    p = token_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps({"access_token": token,
                               "issued_at": (now or datetime.now(IST)).isoformat()}), encoding="utf-8")
    tmp.replace(p)


def load_token(now: datetime | None = None) -> str | None:
    """Today's access token, or None if there is none or it has passed 06:30 IST since issue."""
    now = now or datetime.now(IST)
    try:
        data = json.loads(token_path().read_text(encoding="utf-8"))
        issued = datetime.fromisoformat(data["issued_at"])
    except (OSError, ValueError, KeyError):
        return None
    return data.get("access_token") if issued >= last_expiry(now) else None


# ---------------------------------------------------------------- instruments and the feed

INDEX_SYMBOLS = (("nifty", "Nifty 50", "NSE:NIFTY50-INDEX"), ("vix", "India VIX", "NSE:INDIAVIX-INDEX"))
RESTART_AFTER_ERROR = 60  # seconds


def future_symbol(expiry: date, today: date) -> tuple[str, str]:
    """Fyers symbol and label of the near-month Nifty future, from the last known near expiry
    (daily_market.fut_expiry); after that expiry, the next month's contract."""
    m = expiry if today <= expiry else expiry.replace(day=1) + timedelta(days=32)
    return f"NSE:NIFTY{m:%y}{m:%b}FUT".upper(), f"Nifty {m:%b} future"


def instruments(dm: pd.DataFrame, today: date) -> list[tuple[str, str, str]]:
    items = list(INDEX_SYMBOLS)
    if not dm.empty and pd.notna(dm["fut_expiry"].iloc[-1]):
        sym, label = future_symbol(pd.Timestamp(dm["fut_expiry"].iloc[-1]).date(), today)
        items.append(("fut", label, sym))
    return items


class Feed:
    """Latest tick per symbol and today's 1-minute Nifty bars from the Fyers data WebSocket.
    One per API process; started by the first /live request that finds a valid token."""

    BAR_SYMBOL = "NSE:NIFTY50-INDEX"

    def __init__(self):
        self._lock = threading.Lock()
        self._sock = None
        self.token: str | None = None
        self.symbols: list[str] = []
        self.state, self.message = "stopped", None
        self.ticks: dict[str, dict] = {}
        self.bars: list[list[float]] = []  # [minute epoch, open, high, low, close]
        self.last_tick_at: float | None = None
        self._started_at = 0.0

    def snapshot(self) -> dict:
        with self._lock:
            return {"state": self.state, "message": self.message, "last_tick_at": self.last_tick_at,
                    "ticks": {k: dict(v) for k, v in self.ticks.items()}, "bars": [list(b) for b in self.bars]}

    def start(self, s: FyersSettings, token: str, symbols: list[str]) -> None:
        """Connect, unless already running on this token and symbols. After an error, retry at
        most once a minute: each start makes one REST call, and the dashboard polls often."""
        with self._lock:
            if self.token == token and self.symbols == symbols and (
                    self.state != "error" or clock_time.time() - self._started_at < RESTART_AFTER_ERROR):
                return
            self._close_locked()
            self._started_at = clock_time.time()
            self.token, self.symbols = token, list(symbols)
            self.state, self.message, self.ticks, self.bars = "connecting", None, {}, []
        threading.Thread(target=self._run, args=(s, token, list(symbols)), daemon=True,
                         name="fyers-feed").start()

    def stop(self) -> None:
        with self._lock:
            self._close_locked()
            self.token, self.state, self.message = None, "stopped", None

    def _close_locked(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close_connection()
            except Exception as e:  # already closed
                log.debug("fyers socket close: %s", e)
            self._sock = None

    def _set(self, state: str, message: str | None, token: str) -> None:
        with self._lock:
            if self.token == token:
                self.state, self.message = state, message

    def _run(self, s: FyersSettings, token: str, symbols: list[str]) -> None:
        self._backfill_bars(s, token)
        try:
            from fyers_apiv3.FyersWebsocket import data_ws
        except ImportError:
            self._set("error", "Fyers SDK not installed: see quant/README.md, 'Live view'", token)
            return
        log_dir = config.DATA_DIR / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        sock = None

        def on_connect():
            sock.subscribe(symbols=symbols, data_type="SymbolUpdate")
            self._set("live", None, token)

        sock = data_ws.FyersDataSocket(
            access_token=f"{s.app_id}:{token}", write_to_file=False, log_path=str(log_dir), litemode=False,
            reconnect=True, on_connect=on_connect, on_message=lambda m: self.on_message(m, token),
            on_error=lambda m: self._on_error(m, token), on_close=lambda m: self._set("disconnected", str(m), token))
        with self._lock:
            if self.token != token:
                return
            self._sock = sock
        sock.connect()

    def _on_error(self, msg, token: str) -> None:
        log.warning("fyers feed error: %s", msg)
        self._set("error", str(msg.get("message", msg) if isinstance(msg, dict) else msg), token)

    def on_message(self, msg: dict, token: str | None = None) -> None:
        if not isinstance(msg, dict):
            return
        if "symbol" not in msg or "ltp" not in msg:
            if msg.get("s") == "error":  # auth, subscription or token errors arrive as messages
                self._set("error", str(msg.get("message", "Fyers error")), token or self.token)
            return
        now = clock_time.time()
        with self._lock:
            if token is not None and token != self.token:
                return
            sym = msg["symbol"]
            self.ticks[sym] = {**self.ticks.get(sym, {}), **msg, "received_at": now}
            self.last_tick_at = now
            if self.state != "live":
                self.state, self.message = "live", None
            if sym == self.BAR_SYMBOL:
                self._add_bar(int(msg.get("exch_feed_time") or now), float(msg["ltp"]))

    def _add_bar(self, ts: int, price: float) -> None:
        minute = ts - ts % 60
        day = datetime.fromtimestamp(minute, IST).date()
        if self.bars and datetime.fromtimestamp(self.bars[-1][0], IST).date() != day:
            self.bars = []  # a new day
        if self.bars and self.bars[-1][0] == minute:
            b = self.bars[-1]
            b[2], b[3], b[4] = max(b[2], price), min(b[3], price), price
        elif not self.bars or minute > self.bars[-1][0]:
            self.bars.append([minute, price, price, price, price])

    def _backfill_bars(self, s: FyersSettings, token: str) -> None:
        """Today's 1-minute Nifty bars so far (one REST call), so a restart mid-session keeps the chart."""
        today = datetime.now(IST).date().isoformat()
        try:
            r = requests.get(f"{FYERS_API}/data/history", headers=s.auth_header(token), timeout=20,
                             params={"symbol": self.BAR_SYMBOL, "resolution": "1", "date_format": "1",
                                     "range_from": today, "range_to": today, "cont_flag": "1"})
            body = r.json()
        except (requests.RequestException, ValueError) as e:
            log.warning("fyers history backfill failed: %s", e)
            return
        if body.get("s") != "ok":
            log.warning("fyers history backfill: %s", body.get("message"))
            return
        bars = [[int(c[0]), float(c[1]), float(c[2]), float(c[3]), float(c[4])] for c in body.get("candles") or []]
        with self._lock:
            if self.token == token:
                live = [b for b in self.bars if not bars or b[0] > bars[-1][0]]
                self.bars = bars + live


FEED = Feed()


# ---------------------------------------------------------------- the view served at /live

def _eod_quotes(dm: pd.DataFrame, items: list[tuple[str, str, str]]) -> dict[str, dict]:
    """Last end-of-day close per instrument, for when there is no live tick."""
    if dm.empty:
        return {}
    last = dm.iloc[-1]
    prev = dm.iloc[-2] if len(dm) > 1 else last
    cols = {"nifty": ("spot_open", "spot_high", "spot_low", "spot_close"),
            "vix": ("vix_open", "vix_high", "vix_low", "vix_close"),
            "fut": (None, None, None, "fut_close")}
    out = {}
    for key, _, _ in items:
        o, h, lo, c = cols[key]
        ltp, pc = last[c], prev[c]
        if key == "fut" and prev["fut_expiry"] != last["fut_expiry"]:
            pc = None  # the near contract rolled: yesterday's close is a different contract
        out[key] = {"ltp": ltp, "prev_close": pc, "open": last[o] if o else None,
                    "high": last[h] if h else None, "low": last[lo] if lo else None,
                    "volume": last["fut_volume_contracts"] if key == "fut" else None,
                    "oi": last["fut_oi_units"] if key == "fut" else None,
                    "as_of": pd.Timestamp(last["trade_date"]).date().isoformat()}
    return out


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if x != x else x


def view(now: datetime | None = None, feed: Feed = FEED) -> dict:
    """Market clock, feed state and one quote per instrument (live tick, else last close)."""
    now = (now or datetime.now(IST)).astimezone(IST)
    dm = analytics.load_derived(analytics.DAILY_MARKET)
    items = instruments(dm, now.date())
    s = FyersSettings.from_env()
    if s is None:
        feed_info = {"state": "not_configured", "message": "Set FYERS_APP_ID and FYERS_SECRET_KEY in .env"}
    else:
        token = load_token(now)
        if token is None:
            feed.stop()
            feed_info = {"state": "login_required", "login_url": s.start_url,
                         "message": "Log in to Fyers to start live prices (once a day; tokens expire at 06:30 IST)"}
        else:
            feed.start(s, token, [sym for _, _, sym in items])
            feed_info = {"state": None, "login_url": s.start_url}
    snap = feed.snapshot()
    if feed_info.get("state") is None:
        feed_info.update(state=snap["state"], message=snap["message"])
    last_tick = snap["last_tick_at"]
    feed_info["last_tick_at"] = datetime.fromtimestamp(last_tick, IST).isoformat(timespec="seconds") if last_tick else None

    eod = _eod_quotes(dm, items)
    quotes = []
    for key, label, sym in items:
        t = snap["ticks"].get(sym)
        if t:
            q = {"ltp": t.get("ltp"), "prev_close": t.get("prev_close_price"), "open": t.get("open_price"),
                 "high": t.get("high_price"), "low": t.get("low_price"), "volume": t.get("vol_traded_today"),
                 "oi": t.get("OI"), "source": "live",
                 "as_of": datetime.fromtimestamp(int(t.get("exch_feed_time") or t["received_at"]), IST)
                 .isoformat(timespec="seconds")}
        elif key in eod:
            q = {**eod[key], "source": "close"}
        else:
            continue
        ltp, pc = _num(q["ltp"]), _num(q["prev_close"])
        quotes.append({"key": key, "label": label, "symbol": sym, "source": q["source"], "as_of": q["as_of"],
                       "ltp": ltp, "prev_close": pc, "change": ltp - pc if ltp is not None and pc else None,
                       "change_pct": (ltp / pc - 1) * 100 if ltp is not None and pc else None,
                       "open": _num(q["open"]), "high": _num(q["high"]), "low": _num(q["low"]),
                       "volume": _num(q["volume"]), "oi": _num(q["oi"])})
    bars = [{"time": datetime.fromtimestamp(b[0], IST).isoformat(timespec="minutes"), "open": b[1], "high": b[2],
             "low": b[3], "close": b[4]} for b in snap["bars"]
            if datetime.fromtimestamp(b[0], IST).date() == now.date()]
    return {"market": market_clock(now), "feed": feed_info, "quotes": quotes, "bars": bars}
