package com.niftyquant.live;

import com.niftyquant.quant.QuantClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Live view: market open/closed and live Nifty quotes once Fyers is logged in (see quant live.py). */
@RestController
@RequestMapping("/api/live")
public class LiveController {

    private final QuantClient quant;

    public LiveController(QuantClient quant) {
        this.quant = quant;
    }

    @GetMapping
    public LiveView live() {
        return quant.live();
    }
}
