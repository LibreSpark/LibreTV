from __future__ import annotations

import re
import sys
import time
from urllib.parse import urlparse

from scrapling.fetchers import Fetcher

from seedhub import parse_catalog_html, parse_detail_html

ORIGIN = "https://www.seedhub.cc"
CATEGORY_PATHS = {"movies": 1, "series": 3, "anime": 2}
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": ORIGIN + "/",
}


def fetch_html(url: str) -> str:
    response = Fetcher.get(url, headers=REQUEST_HEADERS, timeout=25, follow_redirects="safe")
    final_url = urlparse(str(getattr(response, "url", url)))
    if final_url.scheme != "https" or final_url.hostname != "www.seedhub.cc":
        raise RuntimeError(f"Unexpected redirect while reading fixed SeedHub URL: {url}")
    status = getattr(response, "status", getattr(response, "status_code", 200))
    if isinstance(status, int) and status >= 400:
        raise RuntimeError(f"SeedHub returned HTTP {status} for {url}")
    html = getattr(response, "text", None)
    if not isinstance(html, str) or not html:
        html = getattr(response, "html_content", None)
    if not isinstance(html, str) or not html:
        raise RuntimeError(f"SeedHub returned an empty HTML document for {url}")
    return html


def main() -> int:
    totals: dict[str, int] = {}
    detail_samples: dict[str, dict] = {}
    for category, category_id in CATEGORY_PATHS.items():
        # SeedHub currently exposes the three public catalogues under these fixed paths.
        url = f"{ORIGIN}/categories/{category_id}/movies/"
        html = fetch_html(url)
        items = parse_catalog_html(html, url, category)
        if len(items) < 10:
            raise RuntimeError(f"{category}: expected at least 10 catalogue records, got {len(items)}")
        # SeedHub uses the /movies/<id>/ detail route for all three catalogues.
        allowed_detail_prefixes = ("/movies/", "/series/", "/anime/")
        if any(not urlparse(item["source_url"]).path.startswith(allowed_detail_prefixes) for item in items):
            raise RuntimeError(f"{category}: parser returned a URL outside supported detail routes")
        unique_urls = {item["source_url"] for item in items}
        if len(unique_urls) != len(items):
            raise RuntimeError(f"{category}: duplicate detail URLs in one catalogue page")
        posters = sum(bool(item.get("poster_url")) for item in items)
        if posters == 0:
            image_tags = re.findall(r"<img[^>]{0,500}>", html, flags=re.IGNORECASE)
            image_indexes = [match.start() for match in re.finditer(r"<img", html, flags=re.IGNORECASE)]
            image_index = image_indexes[1] if len(image_indexes) > 1 else (image_indexes[0] if image_indexes else -1)
            excerpt = html[max(0, image_index - 1800):image_index + 2200] if image_index >= 0 else html[:3000]
            print("SEEDHUB_LIVE_DIAGNOSTIC image_tags=" + repr(image_tags[:12]), flush=True)
            print("SEEDHUB_LIVE_DIAGNOSTIC image_context=" + repr(excerpt), flush=True)
            raise RuntimeError(f"{category}: no real poster URLs were extracted")
        page_two_url = url + "?page=2"
        page_two_html = fetch_html(page_two_url)
        page_two_items = parse_catalog_html(page_two_html, page_two_url, category)
        if len(page_two_items) < 10:
            raise RuntimeError(f"{category}: expected at least 10 records on page 2, got {len(page_two_items)}")
        overlap = {item["source_url"] for item in items} & {item["source_url"] for item in page_two_items}
        if overlap:
            print(
                "SEEDHUB_LIVE_DIAGNOSTIC pagination "
                f"category={category} page1_titles={[item['title'] for item in items[:5]]!r} "
                f"page2_titles={[item['title'] for item in page_two_items[:5]]!r} "
                f"overlap={sorted(overlap)[:5]!r}",
                flush=True,
            )
            if len(overlap) == min(len(items), len(page_two_items)):
                raise RuntimeError(f"{category}: page 1 and page 2 are identical; pagination response was not advanced")
        page_two_posters = sum(bool(item.get("poster_url")) for item in page_two_items)
        if page_two_posters == 0:
            raise RuntimeError(f"{category}: page 2 has no extracted poster URLs")
        page_two_urls = {item["source_url"] for item in page_two_items}
        unique_across_pages = unique_urls | page_two_urls
        duplicate_across_pages = len(items) + len(page_two_items) - len(unique_across_pages)
        totals[category] = len(unique_across_pages)
        detail_samples[category] = items[0]
        print(
            f"PASS catalogue {category}: page1={len(items)} posters={posters}, "
            f"page2={len(page_two_items)} posters={page_two_posters}, "
            f"unique_across_pages={len(unique_across_pages)}, duplicates={duplicate_across_pages}"
        )
        time.sleep(1)

    # Every SeedHub content type currently shares /movies/<id>/ detail URLs.
    # Carry the catalogue category explicitly and verify it survives live parsing.
    for category, item in detail_samples.items():
        detail_url = item["source_url"]
        detail_html = fetch_html(detail_url)
        detail = parse_detail_html(detail_html, detail_url, category)
        if detail.get("category") != category:
            raise RuntimeError(f"{category}: detail category was not preserved from its catalogue")
        if not detail.get("title") or not detail.get("description"):
            raise RuntimeError(f"{category}: live detail is missing title or synopsis")
        if not detail.get("poster_url"):
            raise RuntimeError(f"{category}: live detail has no extracted poster")
        if not detail.get("still_urls"):
            raise RuntimeError(f"{category}: live detail has no extracted still images")
        if not detail.get("metadata"):
            raise RuntimeError(f"{category}: live detail has no extracted metadata fields")
        if detail.get("external_resource_links_extracted") is not False:
            raise RuntimeError("The live probe must never extract external share/download links")
        print(
            f"PASS detail {category}: title={detail['title']!r}, "
            f"poster=yes, stills={len(detail['still_urls'])}, "
            f"metadata_fields={','.join(sorted(detail['metadata']))}, category_preserved=yes"
        )
        time.sleep(1)

    print("SEEDHUB_LIVE_SMOKE_OK " + " ".join(f"{key}={value}" for key, value in totals.items()))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"SEEDHUB_LIVE_SMOKE_FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
