package com.niftyquant.data;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** What has been downloaded, what is still open, and the latest data-quality result. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record DataStatus(
        List<Dataset> datasets,
        String lastFetch,
        List<OpenItem> openItems,
        Quality quality) {

    /** Status counts (ok, holiday, missing, error, pending) overall and per year. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Dataset(
            String dataset,
            LocalDate firstDate,
            LocalDate lastDate,
            Map<String, Integer> totals,
            List<Map<String, Integer>> years) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record OpenItem(String dataset, LocalDate tradeDate, String status, String message) {
    }

    /** Check name -> number of failing rows (0 = pass). */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Quality(String report, Map<String, Integer> checks) {
    }
}
