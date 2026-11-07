package com.niftyquant.data;

import com.niftyquant.quant.QuantClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/data")
public class DataController {

    private final QuantClient quant;
    private final PostgresStatusRepository postgres;

    public DataController(QuantClient quant, PostgresStatusRepository postgres) {
        this.quant = quant;
        this.postgres = postgres;
    }

    @GetMapping("/status")
    public DataStatus status() {
        return quant.dataStatus();
    }

    @GetMapping("/postgres")
    public PostgresStatus postgres() {
        return postgres.status();
    }
}
