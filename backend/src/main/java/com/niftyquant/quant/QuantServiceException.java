package com.niftyquant.quant;

import org.springframework.http.HttpStatusCode;

/**
 * The research API failed. {@code status} is the status to return to our caller:
 * the upstream 4xx when the request itself was bad, 503 when the service is down or broken.
 */
public class QuantServiceException extends RuntimeException {

    private final HttpStatusCode status;

    public QuantServiceException(HttpStatusCode status, String message, Throwable cause) {
        super(message, cause);
        this.status = status;
    }

    public HttpStatusCode status() {
        return status;
    }
}
