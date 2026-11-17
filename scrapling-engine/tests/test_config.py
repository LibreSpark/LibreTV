import pytest
from pydantic import SecretStr

from app.config import (
    Settings,
    is_loopback_host,
    validate_bind_security,
    validate_egress_proxy_policy,
)


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "localhost"])
def test_loopback_hosts_do_not_require_api_key(host: str) -> None:
    assert is_loopback_host(host)
    validate_bind_security(host, None)


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.0.2.10", "crawler.internal"])
def test_non_loopback_hosts_require_api_key(host: str) -> None:
    assert not is_loopback_host(host)
    with pytest.raises(RuntimeError, match="SCRAPLING_API_KEY is required"):
        validate_bind_security(host, None)


def test_non_loopback_host_accepts_configured_api_key() -> None:
    validate_bind_security("0.0.0.0", SecretStr("x" * 32))


def test_crawler_policy_fails_closed_without_egress_proxy() -> None:
    with pytest.raises(RuntimeError, match="SCRAPLING_EGRESS_PROXY is required"):
        validate_egress_proxy_policy(True, None)


def test_crawler_policy_accepts_configured_egress_proxy() -> None:
    validate_egress_proxy_policy(True, "http://scrapling-egress-proxy:8080")


def test_local_development_may_omit_egress_proxy() -> None:
    validate_egress_proxy_policy(False, None)


@pytest.mark.parametrize("secret", ["short", "x" * 31, "x" * 31 + " "])
def test_invalid_api_key_is_rejected(secret: str) -> None:
    with pytest.raises(RuntimeError, match="SCRAPLING_API_KEY must contain"):
        validate_bind_security("0.0.0.0", SecretStr(secret))


def test_settings_load_secret_api_key_and_required_proxy(monkeypatch) -> None:
    monkeypatch.setenv("SCRAPLING_API_KEY", "x" * 32)
    monkeypatch.setenv("SCRAPLING_EGRESS_PROXY", "http://scrapling-egress-proxy:8080")
    monkeypatch.setenv("SCRAPLING_REQUIRE_EGRESS_PROXY", "true")
    settings = Settings()
    assert settings.api_key is not None
    assert settings.api_key.get_secret_value() == "x" * 32
    assert settings.egress_proxy_url == "http://scrapling-egress-proxy:8080"
    assert settings.require_egress_proxy is True
