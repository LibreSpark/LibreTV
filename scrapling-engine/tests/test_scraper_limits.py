from __future__ import annotations

from unittest.mock import Mock

import pytest

from app.scraper import ScraplingAdapter


def test_fetch_page_applies_user_agent_and_rejects_oversized_response(
    monkeypatch,
) -> None:
    page = Mock()
    page.headers = {"content-length": "11"}
    page.body = b"hello world"
    captured = {}

    def fake_get(url, **kwargs):
        captured.update(kwargs)
        return page

    monkeypatch.setattr("app.scraper.Fetcher.get", fake_get)
    monkeypatch.setattr("app.scraper.settings.max_response_bytes", 10)

    with pytest.raises(ValueError, match="size limit"):
        ScraplingAdapter.fetch_page("https://example.com/")

    assert captured["follow_redirects"] == "safe"
    assert captured["stealthy_headers"] is False
    assert captured["impersonate"] is None
    assert captured["headers"]["User-Agent"]


def test_regex_extraction_rejects_invalid_pattern() -> None:
    page = Mock()
    page.get_all_text.return_value = "chapter twelve"

    with pytest.raises(ValueError, match="Invalid regular expression"):
        ScraplingAdapter.extract(page, "(", "regex")


def test_regex_extraction_converts_timeout_to_validation_error(monkeypatch) -> None:
    page = Mock()
    page.get_all_text.return_value = "chapter twelve"

    def timeout(*args, **kwargs):
        assert kwargs["timeout"] == 0.25
        raise TimeoutError

    monkeypatch.setattr("app.scraper.re.findall", timeout)

    with pytest.raises(ValueError, match="time limit"):
        ScraplingAdapter.extract(page, "chapter", "regex")


def test_fetch_page_can_disable_redirect_following(monkeypatch) -> None:
    page = Mock()
    page.headers = {}
    page.body = b"<html>ok</html>"
    captured = {}

    def fake_get(url, **kwargs):
        captured.update(kwargs)
        return page

    monkeypatch.setattr("app.scraper.Fetcher.get", fake_get)

    result = ScraplingAdapter.fetch_page(
        "https://example.com/",
        timeout=10,
        follow_redirects=False,
    )

    assert result is page
    assert captured["follow_redirects"] is False
