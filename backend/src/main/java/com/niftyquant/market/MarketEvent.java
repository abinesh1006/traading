package com.niftyquant.market;

import java.time.LocalDate;
import java.time.OffsetDateTime;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * One market event (RBI, FOMC, US CPI, Budget, election, special session, expiry, big-move day)
 * with Nifty's move on the first NSE session that could react to it.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MarketEvent(
        /** Date in the event's own time zone (US date for FOMC and CPI). */
        LocalDate eventDate,
        /**
         * Scheduled instant where fixed by rule; null where it varied or is unknown. Jackson normalises
         * it to UTC on the way through, so clients must convert to Asia/Kolkata for display.
         */
        OffsetDateTime eventTimeIst,
        String category,
        String name,
        /** Lands after the Indian close, so the next session reacts. */
        Boolean afterClose,
        /** Date confirmed by a source (for big-move days: cause attributed). */
        Boolean verified,
        Integer changeBp,
        LocalDate reactionSession,
        Double niftyMovePct,
        Double vixChangePct,
        /** Previous session's nearest-expiry ATM IV / sqrt(252): a one-day one-sigma move, %. */
        Double expectedMovePct,
        Double vixClose,
        /** |niftyMovePct| / expectedMovePct. */
        Double surprise) {
}
