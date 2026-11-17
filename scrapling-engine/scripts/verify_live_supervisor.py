from __future__ import annotations

import asyncio
import json
import os
import sys
from urllib.parse import urlsplit

from app.config import settings
from app.robots import ensure_robots_allowed
from app.scraper import ScraplingAdapter
from app.security import validate_public_http_url
from app.supervisor import SupervisorClient


async def main() -> int:
    page_url = os.environ.get("LIVE_ACCEPTANCE_PAGE_URL", "").strip()
    allowed_hosts = {
        value.strip().lower()
        for value in os.environ.get("LIVE_ACCEPTANCE_ALLOWED_HOSTS", "").split(",")
        if value.strip()
    }
    if not page_url or not allowed_hosts:
        raise SystemExit(
            "Set LIVE_ACCEPTANCE_PAGE_URL and an explicit comma-separated "
            "LIVE_ACCEPTANCE_ALLOWED_HOSTS allowlist."
        )

    safe_url = validate_public_http_url(page_url)
    host = (urlsplit(safe_url).hostname or "").lower()
    if host not in allowed_hosts:
        raise SystemExit("The page host is not present in the explicit acceptance allowlist.")
    if settings.supervisor_api_key is None or not settings.supervisor_model:
        raise SystemExit("SUPERVISOR_API_KEY and SUPERVISOR_MODEL are required.")
    if not settings.egress_proxy_url:
        raise SystemExit("SCRAPLING_EGRESS_PROXY is required for live model acceptance.")

    # One authorized page fetch and one model request; no crawling or link expansion.
    await asyncio.to_thread(
        ensure_robots_allowed, safe_url, settings.request_timeout_seconds
    )
    page = await asyncio.to_thread(
        ScraplingAdapter.fetch_page,
        safe_url,
        settings.request_timeout_seconds,
        False,
    )
    status_code = getattr(page, "status", None)
    if not isinstance(status_code, int) or not 200 <= status_code < 300:
        raise SystemExit(
            f"The authorized page did not return a 2xx response (status={status_code!r}); "
            "redirects are not followed by this acceptance check."
        )
    final_url = validate_public_http_url(str(getattr(page, "url", None) or safe_url))
    if (urlsplit(final_url).hostname or "").lower() != host:
        raise SystemExit("The response URL does not match the authorized host; acceptance stopped.")

    body = getattr(page, "body", b"")
    html = (
        bytes(body).decode("utf-8", errors="replace")
        if isinstance(body, (bytes, bytearray))
        else str(body or page.get_all_text(strip=True))
    )[:30_000]
    if not html.strip():
        raise SystemExit("The authorized page returned no HTML sample.")

    client = SupervisorClient(
        settings.supervisor_api_base,
        settings.supervisor_api_key.get_secret_value(),
        settings.supervisor_model,
        settings.supervisor_timeout_seconds,
        proxy=settings.egress_proxy_url,
    )
    rule = await client.generate_extraction_rule(
        os.environ.get(
            "LIVE_ACCEPTANCE_GOAL",
            "Extract the primary public media listing titles from this page.",
        ),
        final_url,
        html,
    )
    extracted = await asyncio.to_thread(
        ScraplingAdapter.extract, page, rule.selector, rule.mode
    )
    values = extracted.get("text", [])
    if not values:
        raise SystemExit(
            "The live model returned a syntactically valid rule, but it matched no elements."
        )

    print(
        json.dumps(
            {
                "status": "passed",
                "verification_level": "live_supervisor_gateway_and_live_page_selector",
                "host": host,
                "model": settings.supervisor_model,
                "mode": rule.mode,
                "selector": rule.selector,
                "match_count": len(values),
                "sample_values": [str(value)[:160] for value in values[:3]],
                "requests": {"authorized_page_fetch": 1, "model_completion": 1},
                "rule_persisted_or_activated": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error_type": type(exc).__name__,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc
