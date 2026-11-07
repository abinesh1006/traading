package com.niftyquant.market;

import java.time.LocalDate;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** Index derivatives positioning of one participant category (Client, DII, FII, Pro), in contracts. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ParticipantPosition(
        LocalDate tradeDate,
        String clientType,
        Long futIndexLong,
        Long futIndexShort,
        Long futIndexNet,
        Double futIndexLongPct,
        Long optIndexCallNet,
        Long optIndexPutNet) {
}
