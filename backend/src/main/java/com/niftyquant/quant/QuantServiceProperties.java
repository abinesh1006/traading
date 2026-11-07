package com.niftyquant.quant;

import java.net.URI;
import java.time.Duration;

import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/** Location of the Python research API (niftyquant serve). */
@Validated
@ConfigurationProperties("quant.service")
public record QuantServiceProperties(@NotNull URI url, Duration connectTimeout, Duration readTimeout) {

    public QuantServiceProperties {
        connectTimeout = connectTimeout == null ? Duration.ofSeconds(2) : connectTimeout;
        readTimeout = readTimeout == null ? Duration.ofSeconds(30) : readTimeout;
    }
}
