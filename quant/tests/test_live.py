"""Live view: market clock, Fyers login/token handling, feed ticks and the /live payload."""

import hashlib
from datetime import date, datetime
from urllib.parse import parse_qs, urlsplit

import pandas as pd
import pytest

from niftyquant import analytics, config, live

IST = live.IST


def at(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=IST)


@pytest.mark.parametrize("now, state, reason, next_open", [
    (at(2026, 11, 9, 8, 50), "closed", "Normal session opens at 09:15", "2026-11-09T09:15+05:30"),
    (at(2026, 11, 9, 9, 5), "pre_open", "Pre-open; trading starts 09:15", "2026-11-09T09:15+05:30"),
    (at(2026, 11, 9, 15, 35), "open", "Normal session, closes 15:40", "2026-11-11T09:15+05:30"),  # 15:40 close since Aug 2026
    (at(2026, 7, 1, 15, 35), "closed", "Closed for the day at 15:30", "2026-07-02T09:15+05:30"),
    (at(2026, 11, 10, 11, 0), "closed", "Holiday: Diwali Balipratipada", "2026-11-11T09:15+05:30"),
    (at(2026, 11, 14, 11, 0), "closed", "Weekend", "2026-11-16T09:15+05:30"),
    # Sunday Muhurat session.
    (at(2026, 11, 8, 14, 0), "closed", "Diwali Muhurat trading opens at 14:20", "2026-11-08T14:20+05:30"),
    (at(2026, 11, 8, 14, 30), "open", "Diwali Muhurat trading, closes 15:30", "2026-11-09T09:15+05:30"),
    (at(2026, 11, 8, 16, 0), "closed", "Closed for the day at 15:30", "2026-11-09T09:15+05:30"),
])
def test_market_clock(now, state, reason, next_open):
    c = live.market_clock(now)
    assert (c["state"], c["reason"], c["next_open"]) == (state, reason, next_open)
    assert c["label"] == live.LABELS[state] and c["calendar_note"] is None


def test_clock_warns_when_the_holiday_list_runs_out():
    assert "2026-12-31" in live.market_clock(at(2027, 1, 4, 10, 0))["calendar_note"]


def test_token_lasts_until_six_thirty_next_morning(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    assert live.load_token(at(2026, 11, 9, 10, 0)) is None
    live.save_token("tok", at(2026, 11, 9, 8, 0))
    assert live.load_token(at(2026, 11, 9, 23, 0)) == "tok"
    assert live.load_token(at(2026, 11, 10, 6, 29)) == "tok"
    assert live.load_token(at(2026, 11, 10, 6, 31)) is None
    live.save_token("early", at(2026, 11, 9, 6, 0))   # issued before 06:30 expires at 06:30 the same day
    assert live.load_token(at(2026, 11, 9, 7, 0)) is None


def test_near_future_symbol_rolls_after_expiry():
    assert live.future_symbol(date(2026, 11, 23), date(2026, 11, 9)) == ("NSE:NIFTY26NOVFUT", "Nifty Nov future")
    assert live.future_symbol(date(2026, 11, 23), date(2026, 11, 25))[0] == "NSE:NIFTY26DECFUT"
    assert live.future_symbol(date(2026, 12, 29), date(2026, 12, 30))[0] == "NSE:NIFTY27JANFUT"


def test_login_url_and_auth_code_exchange():
    s = live.FyersSettings("APP-100", "sec", "http://127.0.0.1:8001/live/fyers/callback")
    q = parse_qs(urlsplit(live.login_url(s)).query)
    assert q["client_id"] == ["APP-100"] and q["response_type"] == ["code"]
    assert q["redirect_uri"] == ["http://127.0.0.1:8001/live/fyers/callback"]
    assert s.start_url == "http://127.0.0.1:8001/live/fyers/login"
    state = q["state"][0]
    assert live.take_login_state(state) and not live.take_login_state(state)  # one use only

    sent = {}

    class R:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    def post(url, json, timeout):
        sent.update(url=url, body=json)
        return R({"s": "ok", "code": 200, "access_token": "abc"})

    assert live.exchange_auth_code(s, "CODE", post=post) == "abc"
    assert sent["url"] == "https://api-t1.fyers.in/api/v3/validate-authcode"
    assert sent["body"] == {"grant_type": "authorization_code", "code": "CODE",
                            "appIdHash": hashlib.sha256(b"APP-100:sec").hexdigest()}
    with pytest.raises(live.FyersError, match="invalid auth code"):
        live.exchange_auth_code(s, "BAD", post=lambda *a, **k: R({"s": "error", "message": "invalid auth code"}))


def test_feed_keeps_latest_tick_and_builds_minute_bars():
    f = live.Feed()
    f.token = "t"
    t0 = int(at(2026, 11, 9, 9, 15).timestamp())
    for dt, px in [(0, 100.0), (20, 103.0), (40, 99.0), (65, 101.0)]:
        f.on_message({"symbol": "NSE:NIFTY50-INDEX", "ltp": px, "prev_close_price": 98.0,
                      "exch_feed_time": t0 + dt, "type": "if"}, "t")
    f.on_message({"type": "cn", "code": 200, "message": "Authentication done", "s": "ok"}, "t")
    snap = f.snapshot()
    assert snap["state"] == "live" and snap["ticks"]["NSE:NIFTY50-INDEX"]["ltp"] == 101.0
    assert snap["bars"]["NSE:NIFTY50-INDEX"] == [[t0, 100.0, 103.0, 99.0, 99.0, None, None],
                                                 [t0 + 60, 101.0, 101.0, 101.0, 101.0, None, None]]
    f.on_message({"symbol": "NSE:NIFTY50-INDEX", "ltp": 1.0}, "old-token")  # from a replaced socket
    assert f.snapshot()["ticks"]["NSE:NIFTY50-INDEX"]["ltp"] == 101.0
    f.on_message({"type": "cn", "s": "error", "message": "Token is expired"}, "t")
    assert (f.snapshot()["state"], f.snapshot()["message"]) == ("error", "Token is expired")


FUT = "NSE:NIFTY26NOVFUT"


def _fut_ticks(f, t0):
    # Cumulative volume 1000 -> 1600 inside the first minute, -> 1900 in the second.
    for dt, px, vol, oi in [(1, 25000.0, 1000, 5_000_000), (30, 25010.0, 1400, 5_010_000),
                            (59, 24995.0, 1600, 5_020_000), (61, 25005.0, 1750, 5_020_000),
                            (90, 25020.0, 1900, 5_030_000)]:
        f.on_message({"symbol": FUT, "ltp": px, "vol_traded_today": vol, "OI": oi, "exch_feed_time": t0 + dt}, "t")


def test_future_bars_carry_minute_volume_and_oi():
    f = live.Feed()
    f.token = "t"
    t0 = int(at(2026, 11, 9, 9, 15).timestamp())
    _fut_ticks(f, t0)
    assert f.snapshot()["bars"][FUT] == [[t0, 25000.0, 25010.0, 24995.0, 24995.0, 600.0, 5_020_000.0],
                                         [t0 + 60, 25005.0, 25020.0, 25005.0, 25020.0, 300.0, 5_030_000.0]]


def test_completed_minutes_are_recorded_and_restored(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CURATED_DIR", tmp_path)
    f = live.Feed()
    f.token = "t"
    t0 = int(at(2026, 11, 9, 9, 15).timestamp())
    _fut_ticks(f, t0)
    assert f.flush(now=t0 + 95) == 1            # the 09:16 minute is still in progress
    assert f.flush(now=t0 + 96) == 1            # still dirty: rewritten, same single row
    assert f.flush(now=t0 + 130) == 2
    assert f.flush(now=t0 + 140) == 0           # nothing new
    df = live.read_bars(date(2026, 11, 9))
    assert list(df.columns) == live.BAR_COLUMNS and len(df) == 2
    assert df["minute"].iloc[0] == pd.Timestamp("2026-11-09 09:15", tz=IST) and df["volume"].tolist() == [600, 300]

    g = live.Feed()                              # an API restart mid-session
    g.restore(date(2026, 11, 9), [FUT, "NSE:NIFTY50-INDEX"])
    assert g.snapshot()["bars"][FUT] == f.snapshot()["bars"][FUT]


def test_history_candles_fill_minutes_before_the_feed(monkeypatch):
    f = live.Feed()
    f.token = "t"
    t0 = int(datetime.now(IST).replace(second=0, microsecond=0).timestamp()) - 600
    f._add_tick(FUT, t0 + 120, 101.0, 50, 7.0)   # a recorded bar for minute 2, with OI
    asked = []

    class R:
        def json(self):
            return {"s": "ok", "candles": [[t0, 100, 102, 99, 101, 10], [t0 + 120, 101, 103, 100, 102, 30],
                                           [t0 + 600, 1, 1, 1, 1, 1]]}   # the minute in progress: skipped

    monkeypatch.setattr(live.requests, "get", lambda url, headers, timeout, params: asked.append(params) or R())
    f._backfill_bars(live.FyersSettings("APP-100", "sec"), "t", [FUT])
    assert asked[0]["symbol"] == FUT and asked[0]["resolution"] == "1"
    assert f.snapshot()["bars"][FUT] == [[t0, 100.0, 102.0, 99.0, 101.0, 10.0, None],
                                         [t0 + 120, 101.0, 103.0, 100.0, 102.0, 30.0, 7.0]]


def _dm():
    return pd.DataFrame({
        "trade_date": [date(2026, 11, 5), date(2026, 11, 6)], "spot_open": [24500.0, 24600.0],
        "spot_high": [24600.0, 25100.0], "spot_low": [24400.0, 24550.0], "spot_close": [24536.6, 25030.35],
        "vix_open": [15.0, 15.6], "vix_high": [16.0, 17.9], "vix_low": [14.9, 15.4], "vix_close": [15.58, 17.47],
        "fut_close": [24588.0, 25032.4], "fut_expiry": [date(2026, 11, 23)] * 2,
        "fut_volume_contracts": [100, 120], "fut_oi_units": [1000, 1100]})


class IdleFeed(live.Feed):
    def start(self, s, token, symbols):  # no network in tests
        if token != self.token:
            self.token, self.symbols, self.state = token, symbols, "connecting"


def test_view_without_fyers_shows_closed_market_and_last_close(monkeypatch):
    monkeypatch.setattr(analytics, "load_derived", lambda name: _dm())
    monkeypatch.delenv("FYERS_APP_ID", raising=False)
    v = live.view(at(2026, 11, 8, 18, 0), feed=IdleFeed())
    assert v["market"]["label"] == "Market closed" and v["feed"]["state"] == "not_configured"
    nifty = {q["key"]: q for q in v["quotes"]}["nifty"]
    assert nifty["source"] == "close" and nifty["as_of"] == "2026-11-06" and nifty["ltp"] == 25030.35
    assert nifty["change"] == pytest.approx(493.75) and nifty["change_pct"] == pytest.approx(2.0123, abs=1e-3)
    assert [q["symbol"] for q in v["quotes"]] == ["NSE:NIFTY50-INDEX", "NSE:INDIAVIX-INDEX", "NSE:NIFTY26NOVFUT"]


def test_view_uses_live_ticks_when_logged_in(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(analytics, "load_derived", lambda name: _dm())
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_SECRET_KEY", "sec")
    now = at(2026, 11, 9, 10, 0)
    feed = IdleFeed()
    v = live.view(now, feed=feed)
    assert v["feed"]["state"] == "login_required" and v["feed"]["login_url"].endswith("/live/fyers/login")
    live.save_token("tok", at(2026, 11, 9, 8, 0))
    live.view(now, feed=feed)
    assert feed.token == "tok" and "NSE:NIFTY26NOVFUT" in feed.symbols
    feed.on_message({"symbol": "NSE:NIFTY50-INDEX", "ltp": 25100.0, "prev_close_price": 25030.35,
                     "open_price": 25050.0, "high_price": 25120.0, "low_price": 25010.0,
                     "exch_feed_time": int(now.timestamp())}, "tok")
    v = live.view(now, feed=feed)
    q = {q["key"]: q for q in v["quotes"]}
    assert v["market"]["state"] == "open" and v["feed"]["state"] == "live"
    assert q["nifty"]["source"] == "live" and q["nifty"]["change"] == pytest.approx(69.65)
    assert q["vix"]["source"] == "close"  # no tick yet: last close, labelled
    assert v["bars"] == [{"time": "2026-11-09T10:00+05:30", "open": 25100.0, "high": 25100.0, "low": 25100.0,
                          "close": 25100.0}]


def test_live_routes(monkeypatch):
    from fastapi.testclient import TestClient
    from niftyquant import api
    monkeypatch.setattr(analytics, "load_derived", lambda name: _dm())
    monkeypatch.delenv("FYERS_APP_ID", raising=False)
    client = TestClient(api.app)
    assert client.get("/live").json()["feed"]["state"] == "not_configured"
    assert client.get("/live/fyers/login").status_code == 503
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_SECRET_KEY", "sec")
    r = client.get("/live/fyers/login", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"].startswith("https://api-t1.fyers.in/api/v3/generate-authcode")
    assert "Login link expired" in client.get("/live/fyers/callback?auth_code=x&state=forged").text
