package com.niftyquant.quant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.io.IOException;
import java.time.LocalDate;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

class QuantClientTest {

    private MockRestServiceServer server;
    private QuantClient client;

    @BeforeEach
    void setUp() {
        var builder = RestClient.builder().baseUrl("http://quant");
        server = MockRestServiceServer.bindTo(builder).build();
        var json = JsonMapper.builder().propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE).build();
        client = new QuantClient(builder.build(), json);
    }

    @Test
    void parsesDailyMarketWithNullsAndUnknownFields() {
        server.expect(requestTo("http://quant/market/daily?start=2026-11-01&end=2026-11-06"))
                .andRespond(withSuccess("""
                        [{"trade_date": "2026-11-06", "spot_close": 25030.35, "vix_close": null,
                          "fut_oi_units": 12088505, "lot_size": 65.0, "near_expiry": "2026-11-09",
                          "some_new_field": 1}]""", MediaType.APPLICATION_JSON));

        var rows = client.dailyMarket(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 6));

        assertThat(rows).hasSize(1);
        var r = rows.getFirst();
        assertThat(r.tradeDate()).isEqualTo(LocalDate.of(2026, 11, 6));
        assertThat(r.spotClose()).isEqualTo(25030.35);
        assertThat(r.vixClose()).isNull();
        assertThat(r.futOiUnits()).isEqualTo(12088505L);
        assertThat(r.lotSize()).isEqualTo(65);
        assertThat(r.nearExpiry()).isEqualTo(LocalDate.of(2026, 11, 9));
    }

    @Test
    void upstream4xxKeepsStatusAndDetail() {
        server.expect(requestTo("http://quant/market/chain?date=2026-11-07"))
                .andRespond(withStatus(HttpStatus.NOT_FOUND).contentType(MediaType.APPLICATION_JSON)
                        .body("{\"detail\": \"no F&O data for 2026-11-07 (holiday or not downloaded)\"}"));

        assertThatThrownBy(() -> client.chain(LocalDate.of(2026, 11, 7), null))
                .isInstanceOf(QuantServiceException.class)
                .hasMessageContaining("holiday")
                .extracting(e -> ((QuantServiceException) e).status().value()).isEqualTo(404);
    }

    @Test
    void serviceDownIs503() {
        server.expect(requestTo("http://quant/data/status")).andRespond(withException(new IOException("refused")));

        assertThatThrownBy(() -> client.dataStatus())
                .isInstanceOf(QuantServiceException.class)
                .extracting(e -> ((QuantServiceException) e).status().value()).isEqualTo(503);
    }

    @Test
    void upstream5xxIs503() {
        server.expect(requestTo("http://quant/market/participants"))
                .andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));

        assertThatThrownBy(() -> client.participants(null, null))
                .extracting(e -> ((QuantServiceException) e).status().value()).isEqualTo(503);
    }
}
