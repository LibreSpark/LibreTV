from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.spider import ScraplingSpiderAdapter


@dataclass
class FakeStats:
    requests_count: int = 1


class FakeSpider:
    def __init__(self, urls, crawldir=None) -> None:
        self.urls = urls
        self.crawldir = crawldir
        self.stats = FakeStats()

    async def stream(self):
        yield {"url": self.urls[0], "title": "streamed fixture"}


def test_spider_adapter_uses_async_stream_without_signal_start(monkeypatch) -> None:
    monkeypatch.setattr("app.spider._SeedSpider", FakeSpider)

    result = asyncio.run(
        ScraplingSpiderAdapter.crawl_async(
            ["https://example.com/"],
        )
    )

    assert result["completed"] is True
    assert result["paused"] is False
    assert result["items"] == [{"url": "https://example.com/", "title": "streamed fixture"}]
    assert result["stats"]["requests_count"] == 1


def test_spider_configures_user_agent_timeout_and_disables_redirects(monkeypatch) -> None:
    captured = {}

    class FakeFetcherSession:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    class FakeManager:
        def add(self, session_id, session):
            captured["session_id"] = session_id
            captured["session"] = session

    monkeypatch.setattr("app.spider.FetcherSession", FakeFetcherSession)
    spider = ScraplingSpiderAdapter.create(["https://example.com/"])
    spider.configure_sessions(FakeManager())

    assert captured["session_id"] == "default"
    assert captured["headers"]["User-Agent"]
    assert captured["timeout"] > 0
    assert captured["follow_redirects"] is False
    assert captured["stealthy_headers"] is False
    assert captured["impersonate"] is None


def test_sync_spider_wrapper_uses_async_stream_in_worker_compatible_mode(
    monkeypatch,
) -> None:
    monkeypatch.setattr("app.spider._SeedSpider", FakeSpider)

    result = ScraplingSpiderAdapter.crawl(["https://example.com/"])

    assert result["completed"] is True
    assert result["items"][0]["title"] == "streamed fixture"
