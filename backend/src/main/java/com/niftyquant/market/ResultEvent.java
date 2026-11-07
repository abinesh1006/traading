package com.niftyquant.market;

import java.time.LocalDate;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One heavyweight quarterly result: what options priced in, how the stock and Nifty reacted.
 * Percentages are in percent; Nifty impact is in index points.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ResultEvent(
        String symbol,
        /** Indian fiscal quarter, e.g. "Q3 FY24" (October-December 2023). */
        String quarter,
        LocalDate quarterEnd,
        /** First session that could trade on the result. */
        LocalDate reactionSession,
        LocalDate preSession,
        /** "confirmed" (news reports) or "inferred" (largest idiosyncratic IV drop in the SEBI window). */
        String source,
        LocalDate inferredSession,
        Double ivDropPts,
        Double marketIvDropPts,
        Double idioIvDropPts,
        Double detectScore,
        Double detectMargin,
        Double preClose,
        Double gapPct,
        Double returnPct,
        @JsonProperty("drift_3d_pct") Double drift3dPct,
        @JsonProperty("pre_drift_5d_pct") Double preDrift5dPct,
        /** Event one-day standard deviation priced in at the pre-session close. */
        Double impliedMovePct,
        Double straddlePct,
        /** |returnPct| / impliedMovePct. */
        Double surprise,
        Double ivPre,
        Double ivPost,
        Double beta,
        Double niftyReturnPct,
        Double abnormalReturnPct,
        Double volumeRatio,
        @JsonProperty("nifty_iv30_change") Double niftyIv30Change,
        Double niftyWeightPct,
        Double niftyMovePoints,
        /** Nifty points the stock added on the reaction session. */
        Double niftyPoints,
        Double niftyAbnormalPoints,
        Double shareOfNiftyMovePct) {
}
