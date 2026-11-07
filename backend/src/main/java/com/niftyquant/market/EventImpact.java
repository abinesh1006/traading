package com.niftyquant.market;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** Per event category: Nifty's move on reaction sessions; category "all_days" is the baseline. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record EventImpact(
        String category,
        String label,
        Integer events,
        Double medianAbsMovePct,
        Double meanAbsMovePct,
        Double p90AbsMovePct,
        Double shareUpPct,
        Double medianSurprise,
        Double medianVixChangePct,
        /** Median |move| on these sessions / median |move| on all sessions. */
        Double moveVsNormal) {
}
