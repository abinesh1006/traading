package com.niftyquant.data;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;

/** What the Python loader has copied into Postgres, per dataset (from load_log). */
public record PostgresStatus(String database, List<LoadedDataset> datasets) {

    public record LoadedDataset(
            String dataset,
            long days,
            long rows,
            LocalDate firstDay,
            LocalDate lastDay,
            OffsetDateTime lastLoadedAt) {
    }
}
