package com.niftyquant.data;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class PostgresStatusRepository {

    private final JdbcClient jdbc;

    public PostgresStatusRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public PostgresStatus status() {
        String database = jdbc.sql("select current_database()").query(String.class).single();
        var datasets = jdbc.sql("""
                        select dataset, count(*) as days, sum(rows) as rows,
                               min(trade_date) as first_day, max(trade_date) as last_day,
                               max(loaded_at) as last_loaded_at
                        from load_log
                        group by dataset
                        order by dataset
                        """)
                .query(PostgresStatus.LoadedDataset.class)
                .list();
        return new PostgresStatus(database, datasets);
    }
}
