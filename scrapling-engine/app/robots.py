from __future__ import annotations

import time
from threading import Lock
from urllib.parse import urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from scrapling.fetchers import Fetcher

from app.config import settings


class RobotsPolicyError(PermissionError):
    pass


class RobotsUnavailableError(RuntimeError):
    pass


_CACHE_TTL_SECONDS = 3600
_cache: dict[str, tuple[float, RobotFileParser]] = {}
_cache_lock = Lock()
_last_request_at: dict[str, float] = {}


def ensure_robots_allowed(url: str, timeout: float | None = None) -> None:
    """Fetch and enforce the origin's robots.txt for one-off HTTP fetches."""
    parts = urlsplit(url)
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    robots_url = urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
    now = time.monotonic()

    with _cache_lock:
        cached = _cache.get(origin)
        if cached and now - cached[0] < _CACHE_TTL_SECONDS:
            parser = cached[1]
        else:
            parser = None

    if parser is None:
        try:
            response = Fetcher.get(
                robots_url,
                timeout=timeout or settings.request_timeout_seconds,
                follow_redirects=False,
                proxy=settings.egress_proxy_url,
                impersonate=None,
                stealthy_headers=False,
                headers={"User-Agent": settings.default_user_agent},
            )
        except Exception as exc:
            raise RobotsUnavailableError(
                "robots.txt could not be checked; refusing the fetch."
            ) from exc
        status = getattr(response, "status", 200)
        if isinstance(status, int) and 300 <= status < 400:
            raise RobotsUnavailableError(
                "robots.txt redirected; refusing to follow an unapproved redirect."
            )
        if isinstance(status, int) and (status in {401, 403, 429} or status >= 500):
            raise RobotsUnavailableError("robots.txt could not be checked; refusing the fetch.")
        parser = RobotFileParser(robots_url)
        if isinstance(status, int) and 400 <= status < 500:
            parser.parse([])
        else:
            body = getattr(response, "body", b"")
            if not isinstance(body, (bytes, bytearray)):
                body = str(body).encode("utf-8")
            if len(body) > settings.max_response_bytes:
                raise RobotsUnavailableError(
                    "robots.txt exceeds the configured response size limit."
                )
            parser.parse(bytes(body).decode("utf-8", errors="replace").splitlines())
        with _cache_lock:
            expired = [
                key for key, (saved_at, _) in _cache.items() if now - saved_at >= _CACHE_TTL_SECONDS
            ]
            for key in expired:
                _cache.pop(key, None)
                _last_request_at.pop(key, None)
            if len(_cache) >= 1024:
                oldest = min(_cache, key=lambda key: _cache[key][0])
                _cache.pop(oldest, None)
                _last_request_at.pop(oldest, None)
            _cache[origin] = (now, parser)

    if not parser.can_fetch(settings.default_user_agent, url):
        raise RobotsPolicyError("The target URL is disallowed by the site's robots.txt policy.")

    crawl_delay = parser.crawl_delay(settings.default_user_agent) or 0
    request_rate = parser.request_rate(settings.default_user_agent)
    rate_delay = (
        request_rate.seconds / request_rate.requests
        if request_rate and request_rate.requests > 0
        else 0
    )
    minimum_delay = max(1.0, float(crawl_delay), rate_delay)
    now = time.monotonic()
    with _cache_lock:
        next_allowed = max(now, _last_request_at.get(origin, 0.0))
        _last_request_at[origin] = next_allowed + minimum_delay
    wait = next_allowed - now
    if wait > 0:
        time.sleep(wait)
