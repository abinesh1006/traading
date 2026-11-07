package com.niftyquant.market;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** Per heavyweight (symbol "ALL" for all of them): results moves against what options priced in. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record ResultSummary(
        String symbol,
        Integer announcements,
        Double medianAbsMovePct,
        Double medianImpliedMovePct,
        /** Share of results that moved more than the implied one-sigma move. */
        Double beatImpliedShare,
        Double medianAbsAbnormalPct,
        Double medianIvDropPts,
        Double upShare,
        /** Share of results whose next three sessions moved the same way as the reaction. */
        Double driftFollowsShare,
        Double medianAbsNiftyPoints,
        Double maxAbsNiftyPoints,
        Double medianNiftyWeightPct) {
}
