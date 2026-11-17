from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.workflow_worker import WorkflowWorker


def _master(uri: str = "variant.m3u8") -> str:
    return f"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n{uri}\n"


def test_hls_variant_protection_is_checked_without_fetching_key_urls(monkeypatch) -> None:
    fetched: list[str] = []

    def fetch(url: str, timeout: int):
        fetched.append(url)
        return SimpleNamespace(
            status=200,
            body=b'#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://example.com/key"\n',
        )

    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_args: None)
    monkeypatch.setattr("app.workflow_worker.ScraplingAdapter.fetch_page", fetch)
    worker = WorkflowWorker("postgresql://unused", "test-worker")

    result = asyncio.run(
        worker._inspect_hls_protection("https://example.com/master.m3u8", _master())
    )

    assert result["protection_state"] == "protected_or_encrypted"
    assert result["protection_methods"] == ["SAMPLE-AES"]
    assert fetched == ["https://example.com/variant.m3u8"]


def test_hls_cross_origin_variant_is_unknown_and_never_fetched(monkeypatch) -> None:
    fetched: list[str] = []
    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_args: None)
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.fetch_page",
        lambda url, timeout: fetched.append(url),
    )
    worker = WorkflowWorker("postgresql://unused", "test-worker")

    result = asyncio.run(
        worker._inspect_hls_protection(
            "https://example.com/master.m3u8",
            _master("https://cdn.example.net/variant.m3u8"),
        )
    )

    assert result["protection_state"] == "unknown"
    assert result["protection_check"] == "incomplete"
    assert fetched == []


def test_hls_same_origin_unencrypted_variant_is_approved_for_review(monkeypatch) -> None:
    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_args: None)
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.fetch_page",
        lambda *_args: SimpleNamespace(status=200, body=b"#EXTM3U\n#EXTINF:6,\nsegment.ts\n"),
    )
    worker = WorkflowWorker("postgresql://unused", "test-worker")

    result = asyncio.run(
        worker._inspect_hls_protection("https://example.com/master.m3u8", _master())
    )

    assert result["protection_state"] == "none"
    assert result["protection_check"] == "complete"
