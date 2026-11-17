import pytest

from app.security import UnsafeTargetError, validate_public_http_url


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://localhost/admin",
        "http://127.0.0.1/",
        "http://10.0.0.2/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://0.0.0.0/",
        "http://192.0.2.1/",
        "http://169.254.169.254/latest/meta-data/",
        "https://user:pass@example.com/",
        "https://@example.com/",
        " https://example.com/",
        "http://example.com:8080/",
        "https://example.com:80/",
        "http://example.com\\@127.0.0.1/",
        "http://example.com/%0d%0aHost:localhost",
    ],
)
def test_rejects_unsafe_targets(url: str) -> None:
    with pytest.raises(UnsafeTargetError):
        validate_public_http_url(url)


@pytest.mark.parametrize("url", ["https://example.com/", "http://example.com/"])
def test_accepts_public_http_urls_without_network_side_effects(
    url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.security.socket.getaddrinfo",
        lambda *args, **kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 443)),
        ],
    )
    assert validate_public_http_url(url) == url


def test_rejects_non_http_scheme() -> None:
    with pytest.raises(UnsafeTargetError):
        validate_public_http_url("ftp://example.com/file")


def test_rejects_control_characters() -> None:
    with pytest.raises(UnsafeTargetError):
        validate_public_http_url("https://example.com/\nheader")


def test_rejects_hostname_with_mixed_public_and_private_dns_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.security.socket.getaddrinfo",
        lambda *args, **kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 443)),
            (2, 1, 6, "", ("10.0.0.5", 443)),
        ],
    )
    with pytest.raises(UnsafeTargetError):
        validate_public_http_url("https://mixed-dns.example/")
