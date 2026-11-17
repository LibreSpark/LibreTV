from __future__ import annotations

from unittest.mock import Mock

import pytest

from app.robots import (
    RobotsPolicyError,
    RobotsUnavailableError,
    ensure_robots_allowed,
)


def test_robots_disallow_is_enforced(monkeypatch) -> None:
    page = Mock()
    page.status = 200
    page.body = b"User-agent: *\nDisallow: /private"
    monkeypatch.setattr("app.robots._cache", {})
    monkeypatch.setattr("app.robots.Fetcher.get", lambda *args, **kwargs: page)

    with pytest.raises(RobotsPolicyError):
        ensure_robots_allowed("https://robots-test.example/private")


def test_robots_404_allows_public_page(monkeypatch) -> None:
    page = Mock()
    page.status = 404
    page.body = b""
    monkeypatch.setattr("app.robots._cache", {})
    monkeypatch.setattr("app.robots.Fetcher.get", lambda *args, **kwargs: page)

    ensure_robots_allowed("https://robots-404.example/public")


def test_robots_server_error_fails_closed(monkeypatch) -> None:
    page = Mock()
    page.status = 503
    page.body = b""
    monkeypatch.setattr("app.robots._cache", {})
    monkeypatch.setattr("app.robots.Fetcher.get", lambda *args, **kwargs: page)

    with pytest.raises(RobotsUnavailableError):
        ensure_robots_allowed("https://robots-down.example/public")


def test_robots_rate_limit_fails_closed(monkeypatch) -> None:
    page = Mock()
    page.status = 429
    page.body = b""
    monkeypatch.setattr("app.robots._cache", {})
    monkeypatch.setattr("app.robots.Fetcher.get", lambda *args, **kwargs: page)

    with pytest.raises(RobotsUnavailableError):
        ensure_robots_allowed("https://robots-rate-limited.example/public")


def test_robots_network_error_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr("app.robots._cache", {})
    monkeypatch.setattr(
        "app.robots.Fetcher.get",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("timeout")),
    )

    with pytest.raises(RobotsUnavailableError):
        ensure_robots_allowed("https://robots-timeout.example/public")


def test_robots_redirect_is_not_followed_and_fails_closed(monkeypatch) -> None:
    page = Mock()
    page.status = 302
    page.body = b""
    captured = {}
    monkeypatch.setattr("app.robots._cache", {})

    def fake_get(*args, **kwargs):
        captured.update(kwargs)
        return page

    monkeypatch.setattr("app.robots.Fetcher.get", fake_get)

    with pytest.raises(RobotsUnavailableError):
        ensure_robots_allowed("https://robots-redirect.example/public")

    assert captured["follow_redirects"] is False
