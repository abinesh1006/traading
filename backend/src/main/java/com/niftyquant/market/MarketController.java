package com.niftyquant.market;

import java.time.LocalDate;
import java.util.List;

import com.niftyquant.quant.QuantClient;
import com.niftyquant.web.BadRequestException;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** End-of-day Nifty market views. Dates are ISO (yyyy-MM-dd); ranges are inclusive. */
@RestController
@RequestMapping("/api/market")
public class MarketController {

    private final QuantClient quant;

    public MarketController(QuantClient quant) {
        this.quant = quant;
    }

    @GetMapping("/daily")
    public List<DailyMarket> daily(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        checkRange(from, to);
        return quant.dailyMarket(from, to);
    }

    @GetMapping("/participants")
    public List<ParticipantPosition> participants(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        checkRange(from, to);
        return quant.participants(from, to);
    }

    @GetMapping("/iv")
    public List<IvDaily> iv(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        checkRange(from, to);
        return quant.iv(from, to);
    }

    @GetMapping("/events")
    public List<MarketEvent> events(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(required = false) String category) {
        checkRange(from, to);
        return quant.events(from, to, category);
    }

    @GetMapping("/events/impact")
    public List<EventImpact> eventImpact() {
        return quant.eventImpact();
    }

    /** Heavyweight quarterly results by reaction session; symbol filters to one stock (e.g. HDFCBANK). */
    @GetMapping("/results")
    public List<ResultEvent> results(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(required = false) String symbol) {
        checkRange(from, to);
        return quant.results(from, to, symbol);
    }

    @GetMapping("/results/summary")
    public List<ResultSummary> resultSummary() {
        return quant.resultSummary();
    }

    @GetMapping("/chain")
    public OptionChain chain(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate expiry) {
        return quant.chain(date, expiry);
    }

    private static void checkRange(LocalDate from, LocalDate to) {
        if (from != null && to != null && from.isAfter(to)) {
            throw new BadRequestException("'from' (" + from + ") is after 'to' (" + to + ")");
        }
    }
}
