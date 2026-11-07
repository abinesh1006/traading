package com.niftyquant.data;

import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

import com.niftyquant.quant.QuantClient;
import com.niftyquant.web.ApiExceptionHandler;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(DataController.class)
@Import(ApiExceptionHandler.class)
class DataControllerTest {

    @Autowired
    MockMvc mvc;

    @MockitoBean
    QuantClient quant;

    @MockitoBean
    PostgresStatusRepository postgres;

    @Test
    void postgresStatusIsSnakeCase() throws Exception {
        given(postgres.status()).willReturn(new PostgresStatus("niftyquant", List.of(
                new PostgresStatus.LoadedDataset("fo_bhavcopy", 2935, 6246379,
                        LocalDate.of(2015, 1, 1), LocalDate.of(2026, 11, 6),
                        OffsetDateTime.of(2026, 11, 7, 14, 30, 0, 0, ZoneOffset.UTC)))));
        mvc.perform(get("/api/data/postgres"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.database").value("niftyquant"))
                .andExpect(jsonPath("$.datasets[0].last_day").value("2026-11-06"))
                .andExpect(jsonPath("$.datasets[0].rows").value(6246379));
    }

    @Test
    void databaseDownIs503() throws Exception {
        given(postgres.status()).willThrow(new DataAccessResourceFailureException("connection refused"));
        mvc.perform(get("/api/data/postgres"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.detail").value("Postgres is unavailable. Is the SSH tunnel (dev.ps1) running?"));
    }
}
