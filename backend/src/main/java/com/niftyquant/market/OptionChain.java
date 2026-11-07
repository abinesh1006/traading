package com.niftyquant.market;

import java.time.LocalDate;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** End-of-day option chain for one trading date and expiry. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record OptionChain(
        LocalDate tradeDate,
        LocalDate expiry,
        List<LocalDate> expiries,
        Double spotClose,
        Double vixClose,
        /** Put-call-parity forward for this expiry (Black-76 underlying). */
        Double forward,
        Integer lotSize,
        List<Row> rows) {

    /**
     * One strike, calls and puts side by side. OI in units, volume in contracts.
     * IV in % a year (null if the option did not trade); delta per point of the forward,
     * theta in points per calendar day, vega in points per vol point.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Row(
            Double strike,
            Double ceClose, Double ceLast, Double ceSettle,
            Long ceOiUnits, Long ceOiChangeUnits, Long ceVolumeContracts, Double ceTurnoverInr,
            Double ceIvPct, Double ceDelta, Double ceGamma, Double ceTheta, Double ceVega,
            Double peClose, Double peLast, Double peSettle,
            Long peOiUnits, Long peOiChangeUnits, Long peVolumeContracts, Double peTurnoverInr,
            Double peIvPct, Double peDelta, Double peGamma, Double peTheta, Double peVega) {
    }
}
