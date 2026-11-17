from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import regex as re
from cssselect.parser import SelectorSyntaxError
from lxml.etree import XPathError
from scrapling.fetchers import Fetcher

from app.config import settings

ExtractMode = Literal["text", "css", "xpath", "regex", "adaptive_css", "adaptive_xpath"]
AdaptiveAction = Literal["save", "relocate"]
_adaptive_storage = Path(settings.crawl_data_dir).expanduser().resolve() / "adaptive.sqlite3"
_adaptive_storage.parent.mkdir(parents=True, exist_ok=True)
Fetcher.configure(
    adaptive=True,
    storage_args={"storage_file": str(_adaptive_storage)},
)
REGEX_TIMEOUT_SECONDS = 0.25


def _element_text(element: Any) -> str:
    if hasattr(element, "get_all_text"):
        return str(element.get_all_text(strip=True))
    if isinstance(element, bytes):
        return element.decode("utf-8", errors="replace")
    return str(element).strip()


class ScraplingAdapter:
    """Thin adapter around upstream Scrapling; no replacement parser is introduced."""

    @staticmethod
    def fetch_page(
        url: str,
        timeout: float = 25.0,
        follow_redirects: bool | str = "safe",
    ) -> Any:
        # Scrapling >=0.4.5 supports safe redirect handling, rejecting redirects
        # to internal/private destinations. Network egress policy is still required
        # to close the DNS-rebinding gap between validation and connection.
        page = Fetcher.get(
            url,
            timeout=timeout,
            follow_redirects=follow_redirects,
            proxy=settings.egress_proxy_url,
            impersonate=None,
            stealthy_headers=False,
            headers={"User-Agent": settings.default_user_agent},
        )
        headers = getattr(page, "headers", {}) or {}
        content_length = headers.get("content-length") if hasattr(headers, "get") else None
        if content_length and str(content_length).isdigit():
            if int(content_length) > settings.max_response_bytes:
                raise ValueError("Target response exceeds the configured size limit.")
        body = getattr(page, "body", None)
        if isinstance(body, (bytes, bytearray)) and len(body) > settings.max_response_bytes:
            raise ValueError("Target response exceeds the configured size limit.")
        return page

    @staticmethod
    def extract(
        page: Any,
        selector: str | None = None,
        mode: ExtractMode = "text",
        adaptive_action: AdaptiveAction | None = None,
    ) -> dict[str, Any]:
        full_text = page.get_all_text(strip=True)
        values: list[str]

        if mode in {"css", "adaptive_css"}:
            if not selector:
                raise ValueError("A CSS selector is required for css extraction.")
            if mode == "adaptive_css":
                try:
                    if adaptive_action == "save":
                        nodes = page.css(selector, auto_save=True)
                    elif adaptive_action == "relocate":
                        nodes = page.css(selector, adaptive=True)
                    else:
                        raise ValueError(
                            "Adaptive CSS extraction requires save or relocate action."
                        )
                except SelectorSyntaxError as exc:
                    raise ValueError("Invalid adaptive CSS selector.") from exc
                if not isinstance(nodes, list):
                    nodes = list(nodes)
            else:
                try:
                    nodes = page.css(selector)
                except SelectorSyntaxError as exc:
                    raise ValueError("Invalid CSS selector.") from exc
            values = [_element_text(node) for node in nodes]
        elif mode in {"xpath", "adaptive_xpath"}:
            if not selector:
                raise ValueError("An XPath expression is required for xpath extraction.")
            if mode == "adaptive_xpath":
                try:
                    if adaptive_action == "save":
                        nodes = page.xpath(selector, auto_save=True)
                    elif adaptive_action == "relocate":
                        nodes = page.xpath(selector, adaptive=True)
                    else:
                        raise ValueError(
                            "Adaptive XPath extraction requires save or relocate action."
                        )
                except XPathError as exc:
                    raise ValueError("Invalid adaptive XPath expression.") from exc
            else:
                try:
                    nodes = page.xpath(selector)
                except XPathError as exc:
                    raise ValueError("Invalid XPath expression.") from exc
            values = [_element_text(node) for node in nodes]
        elif mode == "regex":
            if not selector:
                raise ValueError("A regular expression is required for regex extraction.")
            try:
                values = re.findall(
                    selector,
                    full_text,
                    timeout=REGEX_TIMEOUT_SECONDS,
                )
            except TimeoutError as exc:
                raise ValueError("Regex extraction exceeded its time limit.") from exc
            except re.error as exc:
                raise ValueError("Invalid regular expression.") from exc
            values = [item if isinstance(item, str) else "".join(item) for item in values]
        elif mode == "text":
            values = [full_text]
        else:
            raise ValueError(f"Unsupported extraction mode: {mode}")

        title_node = page.css_first("title::text")
        markdown_method = getattr(page, "markdown", None)
        markdown = markdown_method() if callable(markdown_method) else None

        return {
            "status": getattr(page, "status", None),
            "url": getattr(page, "url", None),
            "title": title_node.get() if title_node else None,
            "text": values,
            "count": len(values),
            "markdown": markdown,
            "adaptive_action": adaptive_action if mode.startswith("adaptive_") else None,
        }
