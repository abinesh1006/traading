package com.niftyquant.market;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.util.List;

import com.niftyquant.quant.QuantClient;
import com.niftyquant.quant.QuantServiceException;
import com.niftyquant.web.ApiExceptionHandler;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(MarketController.class)
@Import(ApiExceptionHandler.class)
class MarketControllerTest {

    @Autowired
    MockMvc mvc;

    @MockitoBean
    QuantClient quant;

    @Test
    void dailyIsSnakeCase() throws Exception {
        var day = LocalDate.of(2026, 11, 6);
        given(quant.dailyMarket(day, day)).willReturn(List.of(new DailyMarket(day,
                null, null, null, 25030.35, null, null, 17.47, null, null, null, null, null, 65,
                null, null, null, null, null, null, null, null, 1.12, null, null, null, null, null)));

        mvc.perform(get("/api/market/daily").param("from", "2026-11-06").param("to", "2026-11-06"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].trade_date").value("2026-11-06"))
                .andExpect(jsonPath("$[0].spot_close").value(25030.35))
                .andExpect(jsonPath("$[0].near_pcr_oi").value(1.12))
                .andExpect(jsonPath("$[0].lot_size").value(65));
    }

    @Test
    void ivNamesWithDigitsKeepPythonSnakeCase() throws Exception {
        var day = LocalDate.of(2026, 11, 6);
        given(quant.iv(null, null)).willReturn(List.of(new IvDaily(day, day.plusDays(3), 18.8, 24998.6,
                day.plusDays(11), 16.9, 14.4, day.plusDays(11), 16.9, 17.4, 16.5, 0.86, 0.11, 17.47, 12.3)));
        mvc.perform(get("/api/market/iv"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].iv_30d").value(14.4))
                .andExpect(jsonPath("$[0].iv_25d_put").value(17.4))
                .andExpect(jsonPath("$[0].rr_25d").value(0.86))
                .andExpect(jsonPath("$[0].rv_20d").value(12.3))
                .andExpect(jsonPath("$[0].near_atm_iv").value(18.8));
    }

    @Test
    void eventsKeepTimeAndOffset() throws Exception {
        var day = LocalDate.of(2026, 10, 28);
        var at = java.time.OffsetDateTime.of(2026, 10, 28, 23, 30, 0, 0, java.time.ZoneOffset.ofHoursMinutes(5, 30));
        given(quant.events(null, null, "fomc")).willReturn(List.of(new MarketEvent(day, at, "fomc", "FOMC decision",
                true, true, null, day.plusDays(1), 1.05, -2.0, 0.7, 12.0, 1.5)));
        mvc.perform(get("/api/market/events").param("category", "fomc"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].event_time_ist").value("2026-10-28T23:30:00+05:30"))
                .andExpect(jsonPath("$[0].reaction_session").value("2026-10-29"))
                .andExpect(jsonPath("$[0].after_close").value(true));
    }

    @Test
    void resultsUseSnakeCaseIncludingDigits() throws Exception {
        var day = LocalDate.of(2024, 1, 17);
        var ev = new ResultEvent("HDFCBANK", "Q3 FY24", LocalDate.of(2023, 12, 31), day, day.minusDays(1),
                "confirmed", null, -7.55, -1.5, -6.06, null, null, 1678.95, -3.1, -8.44, -2.0, 1.2, 3.57, 4.1,
                2.36, 30.08, 37.63, 1.1, -2.09, -6.02, 3.9, 1.6, 13.2, -460.35, -245.41, -175.0, 53.3);
        given(quant.results(null, null, "HDFCBANK")).willReturn(List.of(ev));
        mvc.perform(get("/api/market/results").param("symbol", "HDFCBANK"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].reaction_session").value("2024-01-17"))
                .andExpect(jsonPath("$[0].drift_3d_pct").value(-2.0))
                .andExpect(jsonPath("$[0].pre_drift_5d_pct").value(1.2))
                .andExpect(jsonPath("$[0].nifty_iv30_change").value(1.6))
                .andExpect(jsonPath("$[0].nifty_points").value(-245.41))
                .andExpect(jsonPath("$[0].inferred_session").value(org.hamcrest.Matchers.nullValue()));
    }

    @Test
    void invertedRangeIs400() throws Exception {
        mvc.perform(get("/api/market/daily").param("from", "2026-11-06").param("to", "2026-11-01"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value("'from' (2026-11-06) is after 'to' (2026-11-01)"));
    }

    @Test
    void chainRequiresDate() throws Exception {
        mvc.perform(get("/api/market/chain")).andExpect(status().isBadRequest());
    }

    @Test
    void researchServiceDownIsProblem503() throws Exception {
        given(quant.chain(eq(LocalDate.of(2026, 11, 6)), any()))
                .willThrow(new QuantServiceException(HttpStatus.SERVICE_UNAVAILABLE, "research service unavailable", null));

        mvc.perform(get("/api/market/chain").param("date", "2026-11-06"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.status").value(503))
                .andExpect(jsonPath("$.detail").value("research service unavailable"));
    }
}
