from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

from app.config import settings
from app.security import validate_public_http_url
from app.spider import ScraplingSpiderAdapter


def load_authorized_urls(path: Path, allowed_hosts: set[str], limit: int) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        url = validate_public_http_url(value)
        host = (urlsplit(url).hostname or "").lower()
        if host not in allowed_hosts:
            raise ValueError(f"Line {line_number}: host is not in the explicit allowlist.")
        if url not in seen:
            seen.add(url)
            urls.append(url)
        if len(urls) > limit:
            raise ValueError(f"Input exceeds the configured maximum of {limit} unique URLs.")
    if not urls:
        raise ValueError("The authorized URL list is empty.")
    return urls


async def run(args: argparse.Namespace) -> int:
    if not settings.egress_proxy_url:
        raise ValueError(
            "SCRAPLING_EGRESS_PROXY is required; live acceptance must use "
            "the controlled egress proxy."
        )
    allowed_hosts = {host.strip().lower() for host in args.allowed_hosts.split(",") if host.strip()}
    if not allowed_hosts:
        raise ValueError("--allowed-hosts must contain at least one authorized hostname.")
    urls = load_authorized_urls(args.input, allowed_hosts, args.max_urls)

    # The Spider enforces robots.txt, one concurrent request per domain and a
    # one-second per-domain download delay. This is a seed-only test: no link expansion.
    result = await ScraplingSpiderAdapter.crawl_async(urls)
    items = result.get("items", [])
    successful = sum(
        1
        for item in items
        if isinstance(item, dict)
        and isinstance(item.get("status"), int)
        and 200 <= item["status"] < 300
        and not item.get("error")
    )
    failed = max(0, len(urls) - successful)
    report = {
        "status": "passed" if result.get("completed") and failed == 0 else "incomplete",
        "verification_level": "live_authorized_seed_fetch",
        "submitted_urls": len(urls),
        "returned_items": len(items),
        "successful_responses": successful,
        "redirects_rejected": sum(1 for item in items if isinstance(item, dict) and isinstance(item.get("status"), int) and 300 <= item["status"] < 400),
        "failed_or_missing": failed,
        "host_count": len({urlsplit(url).hostname for url in urls}),
        "rate_policy": "robots.txt obeyed; concurrency=1 per domain; minimum 1 second per domain",
        "link_expansion": False,
        "stats": result.get("stats", {}),
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 2


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a bounded live crawl against an explicit authorized URL list."
    )
    parser.add_argument(
        "--input", type=Path, required=True, help="UTF-8 file with one URL per line."
    )
    parser.add_argument(
        "--allowed-hosts",
        required=True,
        help="Comma-separated exact host allowlist; no wildcards.",
    )
    parser.add_argument("--max-urls", type=int, default=1000)
    args = parser.parse_args()
    if not 1 <= args.max_urls <= 1000:
        parser.error("--max-urls must be between 1 and 1000.")
    try:
        raise SystemExit(asyncio.run(run(args)))
    except Exception as exc:
        print(
            json.dumps(
                {"status": "failed", "error_type": type(exc).__name__, "message": str(exc)[:300]},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
