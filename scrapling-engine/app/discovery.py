from __future__ import annotations

from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit

from app.security import UnsafeTargetError, validate_public_http_url


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    port = parsed.port or (443 if scheme == "https" else 80)
    return scheme, (parsed.hostname or "").lower().rstrip("."), port


def is_same_origin(left: str, right: str) -> bool:
    try:
        return _origin(left) == _origin(right)
    except ValueError:
        return False


def normalize_discovery_link(
    base_url: str,
    raw_href: str,
    *,
    same_origin_only: bool = True,
) -> str | None:
    """Normalize a page link and reject unsafe or out-of-scope destinations."""
    href = raw_href.strip()
    if not href or len(href) > 2048:
        return None
    try:
        absolute, _fragment = urldefrag(urljoin(base_url, href))
        parsed = urlsplit(absolute)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        normalized = urlunsplit(
            (parsed.scheme.lower(), parsed.netloc, parsed.path or "/", parsed.query, "")
        )
        if same_origin_only and _origin(normalized) != _origin(base_url):
            return None
        return validate_public_http_url(normalized)
    except (ValueError, UnsafeTargetError):
        return None


def extract_discovery_links(
    page: object,
    base_url: str,
    *,
    max_links: int = 30,
    same_origin_only: bool = True,
) -> list[str]:
    """Extract a bounded, deduplicated set of safe links from a Scrapling page."""
    css = getattr(page, "css", None)
    if not callable(css):
        return []
    try:
        raw_links = css("a::attr(href)").getall()
    except (AttributeError, TypeError, ValueError):
        return []
    links: list[str] = []
    seen: set[str] = set()
    for raw in raw_links:
        if not isinstance(raw, str):
            continue
        link = normalize_discovery_link(
            base_url,
            raw,
            same_origin_only=same_origin_only,
        )
        if link and link not in seen:
            seen.add(link)
            links.append(link)
            if len(links) >= max_links:
                break
    return links
