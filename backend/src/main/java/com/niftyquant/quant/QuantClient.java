package com.niftyquant.quant;

import java.time.LocalDate;
import java.util.List;

import com.niftyquant.data.DataStatus;
import com.niftyquant.market.DailyMarket;
import com.niftyquant.market.EventImpact;
import com.niftyquant.market.IvDaily;
import com.niftyquant.market.MarketEvent;
import com.niftyquant.market.OptionChain;
import com.niftyquant.market.ParticipantPosition;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.util.UriBuilder;
import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Typed client for the Python research API. Responses are read as text and mapped with the
 * application's JSON mapper so field naming (snake_case) is configured in one place.
 */
@Component
public class QuantClient {

    private final RestClient http;
    private final JsonMapper json;

    @Autowired
    public QuantClient(QuantServiceProperties props, JsonMapper json) {
        this(RestClient.builder()
                .baseUrl(props.url().toString())
                .requestFactory(requestFactory(props))
                .build(), json);
    }

    QuantClient(RestClient http, JsonMapper json) {
        this.http = http;
        this.json = json;
    }

    private static JdkClientHttpRequestFactory requestFactory(QuantServiceProperties props) {
        var client = java.net.http.HttpClient.newBuilder().connectTimeout(props.connectTimeout()).build();
        var factory = new JdkClientHttpRequestFactory(client);
        factory.setReadTimeout(props.readTimeout());
        return factory;
    }

    public List<DailyMarket> dailyMarket(LocalDate from, LocalDate to) {
        return get(b -> range(b.path("/market/daily"), from, to).build(), new TypeReference<>() {});
    }

    public List<ParticipantPosition> participants(LocalDate from, LocalDate to) {
        return get(b -> range(b.path("/market/participants"), from, to).build(), new TypeReference<>() {});
    }

    public List<IvDaily> iv(LocalDate from, LocalDate to) {
        return get(b -> range(b.path("/market/iv"), from, to).build(), new TypeReference<>() {});
    }

    public List<MarketEvent> events(LocalDate from, LocalDate to, String category) {
        return get(b -> {
            range(b.path("/market/events"), from, to);
            if (category != null) {
                b.queryParam("category", category);
            }
            return b.build();
        }, new TypeReference<>() {});
    }

    public List<EventImpact> eventImpact() {
        return get(b -> b.path("/market/events/impact").build(), new TypeReference<>() {});
    }

    public OptionChain chain(LocalDate date, LocalDate expiry) {
        return get(b -> {
            b.path("/market/chain").queryParam("date", date);
            if (expiry != null) {
                b.queryParam("expiry", expiry);
            }
            return b.build();
        }, new TypeReference<>() {});
    }

    public DataStatus dataStatus() {
        return get(b -> b.path("/data/status").build(), new TypeReference<>() {});
    }

    private static UriBuilder range(UriBuilder b, LocalDate from, LocalDate to) {
        if (from != null) {
            b.queryParam("start", from);
        }
        if (to != null) {
            b.queryParam("end", to);
        }
        return b;
    }

    private <T> T get(java.util.function.Function<UriBuilder, java.net.URI> uri, TypeReference<T> type) {
        String body;
        try {
            body = http.get().uri(uri).retrieve().body(String.class);
        } catch (HttpClientErrorException e) {
            throw new QuantServiceException(e.getStatusCode(), detail(e), e);
        } catch (RestClientException e) {
            throw new QuantServiceException(HttpStatus.SERVICE_UNAVAILABLE,
                    "research service unavailable: " + e.getMessage(), e);
        }
        try {
            return json.readValue(body, type);
        } catch (JacksonException e) {
            throw new QuantServiceException(HttpStatus.SERVICE_UNAVAILABLE,
                    "research service returned an unexpected response: " + e.getOriginalMessage(), e);
        }
    }

    /** FastAPI errors look like {"detail": "..."}; pass the message through. */
    private String detail(HttpClientErrorException e) {
        try {
            var node = json.readTree(e.getResponseBodyAsString());
            if (node.has("detail")) {
                var detail = node.get("detail");
                return detail.isString() ? detail.asString() : detail.toString();
            }
        } catch (JacksonException ignored) {
            // fall through
        }
        return e.getMessage();
    }
}
