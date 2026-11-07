package com.niftyquant.market;

import java.time.LocalDate;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * End-of-day Nifty market state for one trading day (NSE bhavcopy + index close).
 * OI fields are in units (index quantity), volumes in contracts. Nulls mean "not available".
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DailyMarket(
        LocalDate tradeDate,
        Double spotOpen, Double spotHigh, Double spotLow, Double spotClose, Double spotReturnPct,
        Double niftyPe, Double vixClose,
        Double futClose, LocalDate futExpiry, Long futOiUnits, Long futVolumeContracts, Double basisPct,
        Integer lotSize,
        Long optVolumeContracts, Long ceOiUnits, Long peOiUnits, Double pcrOi,
        LocalDate nearExpiry, Integer daysToExpiry, Long nearCeOiUnits, Long nearPeOiUnits, Double nearPcrOi,
        Double maxCeOiStrike, Double maxPeOiStrike,
        Double atmStrike, Double atmStraddle, Double atmStraddlePct) {
}
