package com.niftyquant.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * When the backend also serves the built React app (deployed mode), the app routes in the browser.
 * A reload or a bookmark on one of its pages must get index.html, not a 404.
 * In development Vite serves the app and this is never reached.
 */
@Controller
public class SpaForwardController {

    @GetMapping({"/market", "/chain", "/positioning", "/events", "/results", "/data"})
    public String app() {
        return "forward:/index.html";
    }
}
