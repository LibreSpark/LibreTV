from __future__ import annotations

import asyncio
from unittest.mock import Mock

from app.spider import _SeedSpider


def test_spider_skips_text_extraction_for_oversized_page(monkeypatch) -> None:
    monkeypatch.setattr("app.spider.settings.max_response_bytes", 4)
    response = Mock()
    response.body = b"oversized"
    response.url = "https://example.com/"
    response.status = 200
    response.css.return_value.get.return_value = "Oversized"

    async def collect():
        return [item async for item in _SeedSpider([]).parse(response)]

    items = asyncio.run(collect())
    assert items == [
        {
            "url": "https://example.com/",
            "status": 200,
            "error": "response_too_large",
            "bytes": 9,
        }
    ]
