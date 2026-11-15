from __future__ import annotations

import os
import re
import sqlite3
import time
import ipaddress
import socket
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, Header, HTTPException, Query
from scrapling.fetchers import Fetcher

SEEDHUB_ORIGIN = "https://www.seedhub.cc"
SEEDHUB_HOST = "www.seedhub.cc"
SEEDHUB_IMAGE_HOSTS = {SEEDHUB_HOST, "img.seedhub.cc", "sh1.pcie.pppoe.top"}
DB_PATH = Path(os.environ.get("SCRAPLING_DB_PATH", "/data/collector.sqlite3"))
TOKEN = os.environ.get("SCRAPLING_API_TOKEN", "").strip()
router = APIRouter()


class _CatalogParser(HTMLParser):
    """Extract public catalogue metadata only; never follows or extracts share/download URLs."""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.items: list[dict] = []
        self.current: dict | None = None
        self.anchor_depth = 0

    def handle_starttag(self, tag: str, attrs):
        values = dict(attrs)
        if tag == "a":
            href = values.get("href", "")
            parsed = urlparse(urljoin(self.base_url, href))
            if (
                self.current is None
                and parsed.scheme == "https"
                and parsed.hostname == SEEDHUB_HOST
                and re.match(r"^/(?:movies|series|anime)/[^/?#]+/?$", parsed.path)
            ):
                self.current = {
                    "source_url": parsed._replace(query="", fragment="").geturl(),
                    "title": (values.get("title") or "").strip(),
                    "poster_url": None,
                }
                self.anchor_depth = 1
            elif self.current is not None:
                # Nested title anchors must not replace the active card or erase its poster.
                self.anchor_depth += 1
        elif tag == "img" and self.current is not None:
            raw = values.get("data-src") or values.get("data-original") or values.get("src") or ""
            image_url = urljoin(self.base_url, raw)
            image = urlparse(image_url)
            if image.scheme == "https" and image.hostname in SEEDHUB_IMAGE_HOSTS:
                self.current["poster_url"] = image_url
                if not self.current["title"]:
                    self.current["title"] = (values.get("alt") or "").strip()
        elif tag == "br" and self.current is not None:
            self.current["title"] += " "

    def handle_data(self, data):
        if self.current is not None:
            self.current["title"] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            self.anchor_depth -= 1
            if self.anchor_depth <= 0:
                title = re.sub(r"\s+", " ", self.current["title"]).strip()[:240]
                if title and not any(item["source_url"] == self.current["source_url"] for item in self.items):
                    self.current["title"] = title
                    self.items.append(self.current)
                self.current = None


def parse_catalog_html(html: str, page_url: str, category: str = "movies") -> list[dict]:
    parsed = urlparse(page_url)
    if parsed.scheme != "https" or parsed.hostname != SEEDHUB_HOST:
        raise ValueError("SeedHub page URL is outside the fixed source origin")
    if category not in {"movies", "series", "anime"}:
        raise ValueError("Unsupported SeedHub category")
    parser = _CatalogParser(page_url)
    parser.feed(html)
    return [{**item, "category": category, "source_name": "SeedHub"} for item in parser.items]



class _DetailParser(HTMLParser):
    """Extract SeedHub-owned detail metadata and images, never outbound share links."""

    def __init__(self, page_url: str):
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.title_parts: list[str] = []
        self.h1_parts: list[str] = []
        self.description = ""
        self.og_title = ""
        self.og_image = ""
        self.images: list[dict] = []
        self.in_title = False
        self.in_h1 = False
        self.in_heading = False
        self.current_section = ""
        self.section_text: dict[str, list[str]] = {}
        self.all_text: list[str] = []
        self.header_text: list[str] = []
        self.in_header = True
        self.skip_text = 0

    def handle_starttag(self, tag: str, attrs):
        values = dict(attrs)
        if tag in {"script", "style", "noscript"}:
            self.skip_text += 1
        elif tag == "title":
            self.in_title = True
        elif tag == "h1":
            self.in_h1 = True
        elif tag in {"h2", "h3"}:
            self.in_heading = True
            self.in_header = False
        elif tag == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            content = (values.get("content") or "").strip()
            if key == "og:title":
                self.og_title = content
            elif key in {"og:description", "description"} and content and not self.description:
                self.description = content
            elif key == "og:image":
                self.og_image = urljoin(self.page_url, content)
        elif tag == "img":
            raw = values.get("data-src") or values.get("data-original") or values.get("src") or ""
            image_url = urljoin(self.page_url, raw)
            parsed = urlparse(image_url)
            if parsed.scheme == "https" and parsed.hostname in SEEDHUB_IMAGE_HOSTS:
                self.images.append({
                    "url": parsed._replace(query="", fragment="").geturl(),
                    "alt": (values.get("alt") or "").strip()[:160],
                })

    def handle_data(self, data):
        if self.skip_text or not data.strip():
            return
        value = re.sub(r"\s+", " ", data).strip()
        if self.in_heading:
            self.current_section = value
            self.section_text.setdefault(value, [])
        self.all_text.append(value)
        if self.in_header:
            self.header_text.append(value)
        if self.in_title:
            self.title_parts.append(value)
        if self.in_h1:
            self.h1_parts.append(value)
        # The heading label identifies the section; it is not synopsis content.
        if self.current_section and not self.in_heading:
            self.section_text.setdefault(self.current_section, []).append(value)

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self.skip_text:
            self.skip_text -= 1
        elif tag == "title":
            self.in_title = False
        elif tag == "h1":
            self.in_h1 = False
        elif tag in {"h2", "h3"}:
            self.in_heading = False


def parse_detail_html(html: str, page_url: str, category: str = "movies") -> dict:
    parsed = urlparse(page_url)
    if (parsed.scheme != "https" or parsed.hostname != SEEDHUB_HOST or
            not re.fullmatch(r"/(?:movies|series|anime)/[0-9]+/?", parsed.path)):
        raise ValueError("SeedHub detail URL is outside the fixed detail-page scope")
    if category not in {"movies", "series", "anime"}:
        raise ValueError("Unsupported SeedHub category")
    parser = _DetailParser(page_url)
    parser.feed(html)
    clean = lambda parts: re.sub(r"\s+", " ", " ".join(parts)).strip()[:500]
    title = (parser.og_title or clean(parser.h1_parts) or clean(parser.title_parts)).strip()
    # Strip the decorative hash used by some SeedHub Open Graph titles.
    title = re.sub(r"^[#\s]+", "", title).strip()
    if " - SeedHub" in title:
        title = title.split(" - SeedHub", 1)[0].strip()
    def is_artwork_url(raw: str) -> bool:
        candidate = urlparse(raw)
        return (
            candidate.scheme == "https"
            and candidate.hostname in SEEDHUB_IMAGE_HOSTS
            and candidate.path.lower().endswith((".avif", ".jpg", ".jpeg", ".png", ".webp"))
            and not re.search(r"/(?:favicon|icon|logo)(?:[-_.][^/]*)?$", candidate.path, re.IGNORECASE)
        )

    # SeedHub may publish a favicon as og:image. It is not a poster and must
    # never displace the real catalogue poster or detail stills.
    image_urls = list(dict.fromkeys(
        item["url"] for item in parser.images if is_artwork_url(item["url"])
    ))
    og_image = parser.og_image if is_artwork_url(parser.og_image) else ""
    poster = og_image or next(
        (item["url"] for item in parser.images if "海报" in item["alt"] and is_artwork_url(item["url"])),
        image_urls[0] if image_urls else None,
    )
    stills = [url for url in image_urls if url != poster]
    # SeedHub routes every content type through /movies/<id>/; category must
    # come from the originating catalogue, never from the detail URL segment.
    description_section = next(
        (parts for heading, parts in parser.section_text.items() if "简介" in heading),
        [],
    )
    description = parser.description or clean(description_section)
    if not description:
        text_blob = clean(parser.all_text)
        match = re.search(r"(?:简介|剧情简介)[:：]?(.+?)(?=图片|剧照|推荐|资源下载|字幕|$)", text_blob)
        description = match.group(1).strip()[:4000] if match else ""
    # Keep field extraction inside the metadata block; later section headings and
    # synopsis text must not be swallowed into the final field (e.g. runtime).
    fields_blob = clean(parser.header_text)
    def extract_field(label: str, stops: tuple[str, ...]) -> str | None:
        stop_pattern = "|".join(re.escape(item) for item in stops)
        match = re.search(rf"{re.escape(label)}[:：]\s*(.+?)(?=(?:{stop_pattern})[:：]|$)", fields_blob)
        return match.group(1).strip(" /|")[:1000] if match else None
    metadata = {
        "director": extract_field("导演", ("编剧", "主演", "类型")),
        "writers": extract_field("编剧", ("主演", "类型")),
        "cast": extract_field("主演", ("类型", "制片国家/地区")),
        "genres": extract_field("类型", ("制片国家/地区", "语言")),
        "countries": extract_field("制片国家/地区", ("语言", "首播", "集数")),
        "languages": extract_field("语言", ("首播", "集数", "单集片长")),
        "premiere": extract_field("首播", ("集数", "单集片长", "又名")),
        "episode_count": extract_field("集数", ("单集片长", "又名", "豆瓣评分")),
        "runtime": extract_field("单集片长", ("又名", "豆瓣评分")),
        "aliases": extract_field("又名", ("豆瓣评分", "常用标签")),
    }
    return {
        "source_name": "SeedHub",
        "source_url": parsed._replace(query="", fragment="").geturl(),
        "title": title,
        "category": category,
        "description": description[:4000],
        "metadata": {key: value for key, value in metadata.items() if value},
        "poster_url": poster,
        "still_urls": stills[:30],
        "mode": "metadata-only",
        "external_resource_links_extracted": False,
    }


def _require_public_seedhub_host():
    try:
        addresses = {
            ipaddress.ip_address(item[4][0])
            for item in socket.getaddrinfo(SEEDHUB_HOST, 443, type=socket.SOCK_STREAM)
        }
    except (OSError, ValueError):
        raise HTTPException(status_code=502, detail="SeedHub host resolution failed")
    if not addresses or any(not address.is_global for address in addresses):
        raise HTTPException(status_code=503, detail="SeedHub resolved to a non-public network address")


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _initialize():
    with _connect() as conn:
        conn.execute("""
          CREATE TABLE IF NOT EXISTS seedhub_catalog (
            source_url TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
            poster_url TEXT, discovered_at INTEGER NOT NULL, detail_json TEXT,
            detail_attempts INTEGER NOT NULL DEFAULT 0, detail_last_error TEXT,
            PRIMARY KEY(source_url, category)
          )
        """)
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(seedhub_catalog)")}
        if "detail_json" not in columns:
            conn.execute("ALTER TABLE seedhub_catalog ADD COLUMN detail_json TEXT")
        if "detail_attempts" not in columns:
            conn.execute("ALTER TABLE seedhub_catalog ADD COLUMN detail_attempts INTEGER NOT NULL DEFAULT 0")
        if "detail_last_error" not in columns:
            conn.execute("ALTER TABLE seedhub_catalog ADD COLUMN detail_last_error TEXT")
        primary_key_columns = [
            row["name"] for row in sorted(
                (row for row in conn.execute("PRAGMA table_info(seedhub_catalog)") if row["pk"]),
                key=lambda row: row["pk"],
            )
        ]
        if primary_key_columns == ["source_url"]:
            conn.execute("""
              CREATE TABLE seedhub_catalog_v2 (
                source_url TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
                poster_url TEXT, discovered_at INTEGER NOT NULL, detail_json TEXT,
                detail_attempts INTEGER NOT NULL DEFAULT 0, detail_last_error TEXT,
                PRIMARY KEY(source_url, category)
              )
            """)
            conn.execute("""
              INSERT OR REPLACE INTO seedhub_catalog_v2
                (source_url,title,category,poster_url,discovered_at,detail_json,detail_attempts,detail_last_error)
              SELECT source_url,title,category,poster_url,discovered_at,detail_json,detail_attempts,detail_last_error
              FROM seedhub_catalog
            """)
            conn.execute("DROP TABLE seedhub_catalog")
            conn.execute("ALTER TABLE seedhub_catalog_v2 RENAME TO seedhub_catalog")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_seedhub_catalog_category_discovered "
            "ON seedhub_catalog(category,discovered_at DESC)"
        )
        # Retire old catalogue snapshots only when explicitly enabled by the
        # deployment environment; normal tests and detail-cache operations remain intact.
        if os.environ.get("SEEDHUB_PURGE_LEGACY_CATALOG", "").strip() == "1":
            conn.execute(
                "CREATE TABLE IF NOT EXISTS collector_migrations ("
                "migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
            )
            applied = conn.execute(
                "SELECT 1 FROM collector_migrations WHERE migration_id=?",
                ("seedhub_snapshot_purge_v1",),
            ).fetchone()
            if not applied:
                conn.execute("DELETE FROM seedhub_catalog")
                conn.execute(
                    "INSERT INTO collector_migrations(migration_id,applied_at) VALUES(?,?)",
                    ("seedhub_snapshot_purge_v1", int(time.time())),
                )

def _require_auth(authorization: str | None):
    import hmac
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not TOKEN or not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _require_egress_firewall():
    if os.environ.get("SCRAPLING_EGRESS_FIREWALL_CONFIRMED", "").strip() != "1":
        raise HTTPException(status_code=503, detail="SeedHub crawling is disabled until host-level egress filtering is verified")


def _catalog_path(category: str, page: int) -> str:
    category_id = {"movies": 1, "series": 3, "anime": 2}[category]
    section = "movies"
    suffix = "" if page == 1 else f"?page={page}"
    return f"/categories/{category_id}/{section}/{suffix}"


@router.get("/v1/seedhub/detail")
def seedhub_detail(
    url: str = Query(..., min_length=1, max_length=2048),
    category: str | None = Query(default=None, pattern="^(movies|series|anime)$"),
    cache_only: bool = False,
    authorization: str | None = Header(default=None),
):
    _require_auth(authorization)
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname != SEEDHUB_HOST or parsed.username or parsed.password or
            parsed.port not in (None, 443) or
            not re.fullmatch(r"/(?:movies|series|anime)/[0-9]+/?", parsed.path)):
        raise HTTPException(status_code=400, detail="Only SeedHub movie, series, and anime detail pages are accepted")
    page_url = parsed._replace(query="", fragment="").geturl()
    _initialize()
    requested_category = category if isinstance(category, str) else None
    with _connect() as conn:
        existing_rows = conn.execute(
            "SELECT category,detail_json FROM seedhub_catalog WHERE source_url=? ORDER BY discovered_at DESC",
            (page_url,),
        ).fetchall()
    # Prefer the category carried from the directory. If this URL has only one
    # stored row, preserve that category even when a stale caller passes another.
    existing = next(
        (row for row in existing_rows if row["category"] == requested_category),
        None,
    ) if requested_category else (existing_rows[0] if existing_rows else None)
    if existing is None and len(existing_rows) == 1:
        existing = existing_rows[0]
    resolved_category = existing["category"] if existing else (requested_category or "movies")
    if existing and existing["detail_json"]:
        try:
            cached = json.loads(existing["detail_json"])
        except (TypeError, json.JSONDecodeError):
            cached = None
        if (isinstance(cached, dict) and cached.get("detail_status") != "failed" and
                cached.get("category") == resolved_category):
            return cached
    if cache_only:
        raise HTTPException(
            status_code=503,
            detail="SeedHub detail is waiting for the background enrichment queue.",
        )
    _require_egress_firewall()
    _require_public_seedhub_host()
    try:
        response = Fetcher.get(page_url, timeout=25, follow_redirects="safe")
        final_url = str(getattr(response, "url", page_url))
        final = urlparse(final_url)
        if final.scheme != "https" or final.hostname != SEEDHUB_HOST:
            raise ValueError("Unexpected redirect outside SeedHub origin")
        status = getattr(response, "status", getattr(response, "status_code", 200))
        if isinstance(status, int) and status >= 400:
            raise ValueError(f"SeedHub detail returned HTTP {status}")
        html = getattr(response, "text", None)
        if not isinstance(html, str) or not html:
            html = getattr(response, "html_content", None)
        if not isinstance(html, str) or not html:
            raise ValueError("SeedHub returned an empty HTML document")
        detail = parse_detail_html(html, page_url, resolved_category)
        with _connect() as conn:
            conn.execute(
                """INSERT INTO seedhub_catalog(source_url,title,category,poster_url,discovered_at,detail_json)
                   VALUES(?,?,?,?,?,?) ON CONFLICT(source_url,category) DO UPDATE SET
                   title=excluded.title,
                   poster_url=COALESCE(excluded.poster_url,seedhub_catalog.poster_url),
                   detail_json=excluded.detail_json""",
                (detail["source_url"], detail["title"] or detail["source_url"],
                 detail["category"], detail["poster_url"], int(time.time()),
                 json.dumps(detail, ensure_ascii=False)),
            )
        return detail
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SeedHub detail fetch failed: {type(exc).__name__}")


@router.get("/v1/seedhub/search")
def seedhub_search(
    q: str = Query(..., min_length=1, max_length=100),
    category: str | None = Query(default=None, pattern="^(movies|series|anime)$"),
    limit: int = Query(default=20, ge=1, le=50),
    authorization: str | None = Header(default=None),
):
    """Search imported public catalogue metadata; no playback/share URLs are extracted."""
    _require_auth(authorization)
    term = q.strip()
    if not term:
        return {"source": "SeedHub", "query": "", "items": []}
    _initialize()
    pattern = "%" + term + "%"
    with _connect() as conn:
        if category:
            rows = conn.execute(
                """SELECT source_url,title,category,poster_url,discovered_at,detail_json
                   FROM seedhub_catalog
                   WHERE category=? AND (title LIKE ? OR detail_json LIKE ?)
                   ORDER BY discovered_at DESC LIMIT ?""",
                (category, pattern, pattern, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT source_url,title,category,poster_url,discovered_at,detail_json
                   FROM seedhub_catalog
                   WHERE title LIKE ? OR detail_json LIKE ?
                   ORDER BY discovered_at DESC LIMIT ?""",
                (pattern, pattern, limit),
            ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        raw_detail = item.pop("detail_json", None)
        try:
            item["detail"] = json.loads(raw_detail) if raw_detail else None
        except (TypeError, json.JSONDecodeError):
            item["detail"] = None
        items.append(item)
    return {"source": "SeedHub", "query": term, "items": items}


@router.get("/v1/seedhub/catalog")
def seedhub_catalog(
    category: str = Query(default="movies", pattern="^(movies|series|anime)$"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=1000000),
    authorization: str | None = Header(default=None),
):
    _require_auth(authorization)
    _initialize()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT source_url,title,category,poster_url,discovered_at,detail_json FROM seedhub_catalog WHERE category=? ORDER BY discovered_at DESC LIMIT ? OFFSET ?",
            (category, limit, offset),
        ).fetchall()
        total = conn.execute("SELECT COUNT(*) AS n FROM seedhub_catalog WHERE category=?", (category,)).fetchone()["n"]
    items = []
    for row in rows:
        item = dict(row)
        raw_detail = item.pop("detail_json", None)
        try:
            item["detail"] = json.loads(raw_detail) if raw_detail else None
        except (TypeError, json.JSONDecodeError):
            item["detail"] = None
        items.append(item)
    return {"source": "SeedHub", "category": category, "total": total, "items": items}
