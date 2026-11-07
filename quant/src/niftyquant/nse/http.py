"""Polite HTTP client for nsearchives.nseindia.com.

NSE's CDN rejects non-browser user agents, so a generic browser UA is sent.
Missing files come back as 404 or as an HTML error page; both mean "not available".
"""

import logging
import random
import time

import requests

log = logging.getLogger(__name__)

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)


class ArchiveClient:
    def __init__(self, min_interval: float = 0.35, retries: int = 4, timeout: float = 30):
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": BROWSER_UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
        )
        self.min_interval = min_interval
        self.retries = retries
        self.timeout = timeout
        self._last = 0.0

    def _throttle(self) -> None:
        wait = self.min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def get(self, url: str) -> bytes | None:
        """Return the file body, or None if NSE says the file does not exist."""
        error: Exception | None = None
        for attempt in range(self.retries + 1):
            self._throttle()
            try:
                r = self.session.get(url, timeout=self.timeout)
            except requests.RequestException as e:
                error = e
            else:
                if r.status_code == 404:
                    return None
                if r.status_code == 200:
                    head = r.content[:64].lstrip().lower()
                    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
                        return None
                    return r.content
                error = RuntimeError(f"HTTP {r.status_code} for {url}")
            backoff = min(60.0, 2.0**attempt + random.random())
            log.warning("retry %d for %s after %.1fs: %s", attempt + 1, url, backoff, error)
            time.sleep(backoff)
        assert error is not None
        raise error
