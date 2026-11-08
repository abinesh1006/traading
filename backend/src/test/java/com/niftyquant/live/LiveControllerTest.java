package com.niftyquant.live;

import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;

import com.niftyquant.quant.QuantClient;
import com.niftyquant.web.ApiExceptionHandler;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(LiveController.class)
@Import(ApiExceptionHandler.class)
class LiveControllerTest {

    @Autowired
    MockMvc mvc;

    @MockitoBean
    QuantClient quant;

    @Test
    void liveViewIsSnakeCase() throws Exception {
        given(quant.live()).willReturn(new LiveView(
                new LiveView.Market("2026-11-08T16:00:00+05:30", "closed", "Market closed",
                        "Closed for the day at 15:30", "2026-11-08", "Diwali Muhurat trading", "14:20", "15:30",
                        "2026-11-09T09:15+05:30", null),
                new LiveView.Feed("login_required", "Log in to Fyers", "http://127.0.0.1:8001/live/fyers/login", null),
                List.of(new LiveView.Quote("nifty", "Nifty 50", "NSE:NIFTY50-INDEX", "close", "2026-11-06",
                        25030.35, 24536.6, 493.75, 2.01, 24538.2, 25030.35, 24388.05, null, null)),
                List.of()));
        mvc.perform(get("/api/live"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.market.label").value("Market closed"))
                .andExpect(jsonPath("$.market.next_open").value("2026-11-09T09:15+05:30"))
                .andExpect(jsonPath("$.feed.login_url").value("http://127.0.0.1:8001/live/fyers/login"))
                .andExpect(jsonPath("$.quotes[0].change_pct").value(2.01))
                .andExpect(jsonPath("$.quotes[0].prev_close").value(24536.6))
                .andExpect(jsonPath("$.quotes[0].as_of").value("2026-11-06"));
    }
}
