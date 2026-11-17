from __future__ import annotations

from app.discovery import extract_discovery_links, normalize_discovery_link


class _Nodes:
    def __init__(self, values: list[str]) -> None:
        self._values = values

    def getall(self) -> list[str]:
        return self._values


class _Page:
    def __init__(self, links: list[str]) -> None:
        self.links = links

    def css(self, selector: str) -> _Nodes:
        assert selector == "a::attr(href)"
        return _Nodes(self.links)


def test_normalize_relative_link_and_remove_fragment() -> None:
    assert (
        normalize_discovery_link(
            "https://93.184.216.34/catalog/index.html",
            "../movie?id=42#player",
        )
        == "https://93.184.216.34/movie?id=42"
    )


def test_reject_external_origin_and_non_http_links() -> None:
    base = "https://93.184.216.34/"
    assert normalize_discovery_link(base, "https://example.net/movie") is None
    assert normalize_discovery_link(base, "javascript:alert(1)") is None
    assert normalize_discovery_link(base, "mailto:admin@example.net") is None
    assert normalize_discovery_link(base, "//127.0.0.1/admin") is None


def test_extract_discovery_links_is_deduplicated_and_bounded() -> None:
    page = _Page(["/a#top", "/a", "/b", "https://example.net/out", "/c"])
    links = extract_discovery_links(
        page,
        "https://93.184.216.34/",
        max_links=2,
    )
    assert links == [
        "https://93.184.216.34/a",
        "https://93.184.216.34/b",
    ]
