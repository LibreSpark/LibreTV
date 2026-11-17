from __future__ import annotations

import asyncio
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from scrapling.fetchers import FetcherSession
from scrapling.spiders import Response, Spider

from app.config import settings


class _SeedSpider(Spider):
    """A polite, seed-only Spider; link expansion stays disabled pending egress guards."""

    name = "libretv_seed_crawler"
    robots_txt_obey = True
    concurrent_requests = 2
    concurrent_requests_per_domain = 1
    download_delay = 1.0

    def __init__(self, urls: list[str], crawldir: Path | None = None) -> None:
        super().__init__(crawldir=crawldir, interval=60.0)
        self.start_urls = urls
        self.allowed_domains = {(urlsplit(url).hostname or "").lower() for url in urls}

    def configure_sessions(self, manager) -> None:
        manager.add(
            "default",
            FetcherSession(
                headers={"User-Agent": settings.default_user_agent},
                stealthy_headers=False,
                impersonate=None,
                timeout=settings.request_timeout_seconds,
                follow_redirects=False,
                proxy=settings.egress_proxy_url,
            ),
        )

    async def parse(self, response: Response):
        status = getattr(response, "status", None)
        if isinstance(status, int) and 300 <= status < 400:
            yield {
                "url": str(response.url),
                "status": status,
                "error": "redirect_not_followed",
            }
            return
        body = getattr(response, "body", b"")
        if isinstance(body, (bytes, bytearray)) and len(body) > settings.max_response_bytes:
            yield {
                "url": str(response.url),
                "status": getattr(response, "status", None),
                "error": "response_too_large",
                "bytes": len(body),
            }
            return
        title = response.css("title::text").get() or ""
        media_urls: list[str] = []
        selectors = response.css("video::attr(src), source::attr(src)")
        raw_media_urls = selectors.getall()
        raw_media_urls.extend(response.css("a::attr(href)").getall())
        media_extensions = (".m3u8", ".mpd", ".mp4", ".m4v", ".webm", ".mov", ".ts", ".mkv")
        for raw_url in raw_media_urls:
            candidate_url = urljoin(str(response.url), raw_url.strip())
            if urlsplit(candidate_url).path.lower().endswith(media_extensions):
                if candidate_url not in media_urls and len(media_urls) < 20:
                    media_urls.append(candidate_url)
        yield {
            "url": str(response.url),
            "status": getattr(response, "status", None),
            "title": title.strip(),
            "text": response.get_all_text(strip=True)[:20_000],
            "media_urls": media_urls,
        }


class ScraplingSpiderAdapter:
    """Runs Scrapling Spider through its async streaming API."""

    @staticmethod
    def create(urls: list[str], crawldir: Path | None = None) -> _SeedSpider:
        return _SeedSpider(urls, crawldir=crawldir)

    @staticmethod
    async def crawl_async(
        urls: list[str],
        crawldir: Path | None = None,
    ) -> dict[str, Any]:
        spider = ScraplingSpiderAdapter.create(urls, crawldir)
        items: list[dict[str, Any]] = []
        stats: dict[str, Any] = {}
        async for item in spider.stream():
            items.append(item)
            stats = asdict(spider.stats)
        return {
            "items": items,
            "completed": True,
            "paused": False,
            "stats": stats,
        }

    @staticmethod
    def crawl(urls: list[str], crawldir: Path | None = None) -> dict[str, Any]:
        # Kept for the legacy synchronous endpoint. Unlike Spider.start(), stream()
        # does not install process signal handlers, so it is safe in a worker thread.
        return asyncio.run(ScraplingSpiderAdapter.crawl_async(urls, crawldir))
