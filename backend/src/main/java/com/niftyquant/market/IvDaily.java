package com.niftyquant.market;

import java.time.LocalDate;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Daily Nifty volatility summary. All volatilities in % a year. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record IvDaily(
        LocalDate tradeDate,
        LocalDate nearExpiry,
        Double nearAtmIv,
        Double nearForward,
        LocalDate nextExpiry,
        Double nextAtmIv,
        /** 30-day constant-maturity ATM IV from monthly expiries, comparable to India VIX. */
        @JsonProperty("iv_30d") Double iv30d,
        LocalDate skewExpiry,
        Double skewAtmIv,
        @JsonProperty("iv_25d_put") Double iv25dPut,
        @JsonProperty("iv_25d_call") Double iv25dCall,
        /** 25-delta risk reversal: put IV minus call IV. Positive = puts dearer (downside fear). */
        @JsonProperty("rr_25d") Double rr25d,
        /** 25-delta butterfly: wings over ATM. */
        @JsonProperty("bf_25d") Double bf25d,
        Double vixClose,
        /** Realised volatility, 20 sessions, annualised. */
        @JsonProperty("rv_20d") Double rv20d) {
}
