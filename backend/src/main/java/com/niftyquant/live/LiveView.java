package com.niftyquant.live;

import java.util.List;

/**
 * Live market view from the research API's /live: whether NSE is open, the Fyers feed state, one
 * quote per instrument (a live tick, or the last end-of-day close, as {@code source} says) and
 * today's 1-minute Nifty bars. Times are ISO strings with the IST offset, passed through as sent.
 */
public record LiveView(Market market, Feed feed, List<Quote> quotes, List<Bar> bars) {

    /** state: open, pre_open or closed; reason says why (weekend, holiday, closes 15:40...). */
    public record Market(String now, String state, String label, String reason, String sessionDate,
            String sessionName, String sessionOpen, String sessionClose, String nextOpen, String calendarNote) {
    }

    /** state: not_configured, login_required, connecting, live, disconnected, error or stopped. */
    public record Feed(String state, String message, String loginUrl, String lastTickAt) {
    }

    /** source: live (Fyers tick) or close (last end-of-day close, dated by as_of). */
    public record Quote(String key, String label, String symbol, String source, String asOf, Double ltp,
            Double prevClose, Double change, Double changePct, Double open, Double high, Double low,
            Double volume, Double oi) {
    }

    public record Bar(String time, double open, double high, double low, double close) {
    }
}
