import unittest

from seedhub import parse_catalog_html, parse_detail_html


class SeedHubCatalogParserTests(unittest.TestCase):
    def test_extracts_only_seedhub_title_pages_and_poster(self):
        html = """
        <a href="/movies/130096/"><img data-src="https://www.seedhub.cc/posters/a.jpg"><span>生化危机：爆发夜</span></a>
        <a href="https://evil.example/movies/2/">Ignore me</a>
        <a href="/share/magnet-link/">Do not index shares</a>
        """
        items = parse_catalog_html(html, "https://www.seedhub.cc/categories/1/movies/", "movies")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "生化危机：爆发夜")
        self.assertEqual(items[0]["source_url"], "https://www.seedhub.cc/movies/130096/")
        self.assertEqual(items[0]["poster_url"], "https://www.seedhub.cc/posters/a.jpg")
        self.assertNotIn("magnet", items[0]["source_url"])

    def test_catalog_keeps_poster_when_detail_anchor_is_nested(self):
        html = """
        <div class="cover">
          <a class="image" href="/movies/130096/" title="生化危机：爆发夜">
            <img src="https://sh1.pcie.pppoe.top/static/pics/poster.webp" alt="生化危机：爆发夜">
          </a>
          <ul><li><h2><a href="/movies/130096/" aria-hidden="true">#</a> 生化危机：爆发夜</h2></li></ul>
        </div>
        """
        items = parse_catalog_html(html, "https://www.seedhub.cc/categories/1/movies/", "movies")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["poster_url"], "https://sh1.pcie.pppoe.top/static/pics/poster.webp")
        self.assertIn("生化危机", items[0]["title"])

    def test_rejects_untrusted_page_origin(self):
        with self.assertRaises(ValueError):
            parse_catalog_html('<a href="/movies/1/">Title</a>', "https://evil.example/", "movies")

    def test_rejects_unknown_category(self):
        with self.assertRaises(ValueError):
            parse_catalog_html('<a href="/movies/1/">Title</a>', "https://www.seedhub.cc/", "torrent")


class SeedHubDetailParserTests(unittest.TestCase):
    def test_extracts_title_description_poster_and_stills_without_outbound_links(self):
        html = """
        <html><head>
          <meta property="og:title" content="生化危机：爆发夜 Resident Evil - SeedHub">
          <meta property="og:image" content="https://sh1.pcie.pppoe.top/poster.jpg">
        </head><body>
          <h1>生化危机：爆发夜</h1>
          <div>导演：扎克·克雷格</div><div>编剧：谢伊·哈顿</div>
          <div>主演：奥斯汀·艾布拉姆斯 / 保罗·沃尔特·豪泽</div>
          <div>类型：恐怖 / 惊悚 / 科幻</div>
          <div>制片国家/地区：美国</div><div>语言：英语</div>
          <div>首播：2026-09-16</div><div>集数：1</div><div>单集片长：90分钟</div><div>又名：Resident Evil Outbreak</div>
          <h2>生化危机：爆发夜的简介</h2><p>故事聚焦医疗速递员布莱恩，意外深陷病毒浩劫。</p>
          <h2>生化危机：爆发夜的图片</h2>
          <img alt="点击查看图片" src="https://sh1.pcie.pppoe.top/still-1.jpg">
          <a href="https://files.example/share/secret">外部资源链接</a>
        </body></html>
        """
        result = parse_detail_html(html, "https://www.seedhub.cc/movies/130096/")
        self.assertEqual(result["title"], "生化危机：爆发夜 Resident Evil")
        self.assertIn("医疗速递员布莱恩", result["description"])
        self.assertEqual(result["metadata"]["director"], "扎克·克雷格")
        self.assertEqual(result["metadata"]["writers"], "谢伊·哈顿")
        self.assertEqual(result["metadata"]["episode_count"], "1")
        self.assertEqual(result["metadata"]["runtime"], "90分钟")
        self.assertEqual(result["metadata"]["cast"], "奥斯汀·艾布拉姆斯 / 保罗·沃尔特·豪泽")
        self.assertEqual(result["metadata"]["genres"], "恐怖 / 惊悚 / 科幻")
        self.assertEqual(result["metadata"]["countries"], "美国")
        self.assertEqual(result["metadata"]["languages"], "英语")
        self.assertEqual(result["metadata"]["premiere"], "2026-09-16")
        self.assertEqual(result["metadata"]["aliases"], "Resident Evil Outbreak")
        self.assertEqual(result["poster_url"], "https://sh1.pcie.pppoe.top/poster.jpg")
        self.assertEqual(result["still_urls"], ["https://sh1.pcie.pppoe.top/still-1.jpg"])
        self.assertFalse(result["external_resource_links_extracted"])
        self.assertNotIn("files.example", str(result))

    def test_ignores_favicon_as_poster_and_keeps_real_artwork(self):
        html = """
        <html><head>
          <meta property="og:title" content="真实海报测试 - SeedHub">
          <meta property="og:image" content="https://sh1.pcie.pppoe.top/static/img/favicon.ico">
        </head><body>
          <h1>真实海报测试</h1>
          <img alt="网站图标" src="https://sh1.pcie.pppoe.top/static/img/favicon.ico">
          <img alt="真实海报" src="https://sh1.pcie.pppoe.top/static/pics/poster.webp">
          <img alt="剧照" src="https://sh1.pcie.pppoe.top/static/pics/still.webp">
        </body></html>
        """
        result = parse_detail_html(html, "https://www.seedhub.cc/movies/130096/")
        self.assertEqual(result["poster_url"], "https://sh1.pcie.pppoe.top/static/pics/poster.webp")
        self.assertEqual(result["still_urls"], ["https://sh1.pcie.pppoe.top/static/pics/still.webp"])
        self.assertNotIn("favicon.ico", str(result))

    def test_strips_decorative_hash_from_live_style_open_graph_title(self):
        html = '<html><head><meta property="og:title" content="# 生化危机：爆发夜 Resident Evil - SeedHub"></head><body><h1>生化危机：爆发夜</h1></body></html>'
        result = parse_detail_html(html, "https://www.seedhub.cc/movies/130096/")
        self.assertEqual(result["title"], "生化危机：爆发夜 Resident Evil")

    def test_detail_category_comes_from_catalogue_not_shared_movies_url(self):
        html = '<html><head><meta property="og:title" content="谷雨 - SeedHub"></head><body><h1>谷雨</h1></body></html>'
        url = "https://www.seedhub.cc/movies/127423/"
        self.assertEqual(parse_detail_html(html, url, "series")["category"], "series")
        self.assertEqual(parse_detail_html(html, url, "anime")["category"], "anime")
        with self.assertRaises(ValueError):
            parse_detail_html(html, url, "unknown")

    def test_rejects_non_seedhub_or_non_detail_urls(self):
        for url in (
            "https://evil.example/movies/130096/",
            "https://www.seedhub.cc/categories/1/movies/",
            "http://www.seedhub.cc/movies/130096/",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                parse_detail_html("<h1>Title</h1>", url)


class SeedHubDetailCacheTests(unittest.TestCase):
    def test_cached_detail_is_served_without_network_or_egress_access(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        source_url = "https://www.seedhub.cc/movies/127423/"
        cached = {
            "source_name": "SeedHub", "source_url": source_url, "title": "谷雨",
            "category": "series", "description": "已缓存的真实详情",
            "metadata": {"episode_count": "30"}, "poster_url": "https://sh1.pcie.pppoe.top/poster.jpg",
            "still_urls": [], "mode": "metadata-only",
            "external_resource_links_extracted": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"), \
                 patch.object(seedhub, "_require_auth"), \
                 patch.object(seedhub.Fetcher, "get", side_effect=AssertionError("cached detail must not fetch")):
                seedhub._initialize()
                with seedhub._connect() as conn:
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,poster_url,discovered_at,detail_json) VALUES(?,?,?,?,?,?)",
                        (source_url, "谷雨", "series", cached["poster_url"], 1, json.dumps(cached, ensure_ascii=False)),
                    )
                result = seedhub.seedhub_detail(source_url, authorization="Bearer test")

        self.assertEqual(result["category"], "series")
        self.assertEqual(result["description"], "已缓存的真实详情")


class SeedHubDetailPersistenceTests(unittest.TestCase):
    def test_detail_endpoint_persists_full_metadata_for_catalogue_reads(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        html = """
        <html><head><meta property="og:title" content="持久化测试影片">
        <meta property="og:image" content="https://sh1.pcie.pppoe.top/poster.jpg"></head>
        <body><h1>持久化测试影片</h1><div>导演：测试导演</div>
        <h2>持久化测试影片的简介</h2><p>这是用于验证详情持久化的简介。</p>
        <h2>剧照</h2><img src="https://sh1.pcie.pppoe.top/still.jpg"></body></html>
        """

        class Response:
            url = "https://www.seedhub.cc/movies/130096/"
            text = html

        from contextlib import ExitStack
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"))
            stack.enter_context(patch.object(seedhub, "_require_egress_firewall"))
            stack.enter_context(patch.object(seedhub, "_require_public_seedhub_host"))
            stack.enter_context(patch.object(seedhub, "_require_auth"))
            stack.enter_context(patch.object(seedhub.Fetcher, "get", return_value=Response()))
            detail = seedhub.seedhub_detail(
                "https://www.seedhub.cc/movies/130096/",
                category="series",
                authorization="Bearer test",
            )
            catalog = seedhub.seedhub_catalog("series", 50, 0, "Bearer test")

        self.assertEqual(detail["metadata"]["director"], "测试导演")
        self.assertEqual(detail["category"], "series")
        self.assertEqual(catalog["category"], "series")
        self.assertEqual(catalog["total"], 1)
        saved = catalog["items"][0]["detail"]
        self.assertEqual(saved["description"], "这是用于验证详情持久化的简介。")
        self.assertEqual(saved["still_urls"], ["https://sh1.pcie.pppoe.top/still.jpg"])




class SeedHubDetailRetryAndCategoryTests(unittest.TestCase):
    def test_same_detail_url_can_be_registered_in_multiple_catalogue_categories(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        source_url = "https://www.seedhub.cc/movies/130096/"
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"):
                seedhub._initialize()
                with seedhub._connect() as conn:
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "同一详情路径", "series", 1),
                    )
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "同一详情路径", "anime", 2),
                    )
                    categories = {
                        row["category"] for row in conn.execute(
                            "SELECT category FROM seedhub_catalog WHERE source_url=?", (source_url,)
                        )
                    }
        self.assertEqual(categories, {"series", "anime"})

    def test_registered_catalogue_category_wins_over_detail_query_category(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        source_url = "https://www.seedhub.cc/movies/130096/"
        html = """<html><head><meta property="og:title" content="谷雨">
        <meta property="og:image" content="https://sh1.pcie.pppoe.top/poster.jpg"></head>
        <body><h1>谷雨</h1></body></html>"""

        class Response:
            url = source_url
            status = 200
            text = html

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"), patch.object(seedhub, "_require_auth"), patch.object(seedhub, "_require_egress_firewall"), patch.object(seedhub, "_require_public_seedhub_host"), patch.object(seedhub.Fetcher, "get", return_value=Response()):
                seedhub._initialize()
                with seedhub._connect() as conn:
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "谷雨", "series", 1),
                    )
                detail = seedhub.seedhub_detail(source_url, category="anime", authorization="Bearer test")
                with seedhub._connect() as conn:
                    saved = conn.execute(
                        "SELECT category FROM seedhub_catalog WHERE source_url=?", (source_url,)
                    ).fetchone()
        self.assertEqual(detail["category"], "series")
        self.assertEqual(saved["category"], "series")

class SeedHubCatalogueSchemaMigrationTests(unittest.TestCase):
    def test_legacy_source_url_primary_key_migrates_to_source_and_category_key(self):
        import sqlite3
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        source_url = "https://www.seedhub.cc/movies/130096/"
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "catalog.sqlite3"
            with sqlite3.connect(db_path) as conn:
                conn.execute("""
                    CREATE TABLE seedhub_catalog (
                      source_url TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL,
                      poster_url TEXT, discovered_at INTEGER NOT NULL, detail_json TEXT
                    )
                """)
                conn.execute(
                    "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                    (source_url, "谷雨", "series", 1),
                )
            with patch.object(seedhub, "DB_PATH", db_path):
                seedhub._initialize()
                with seedhub._connect() as conn:
                    primary_key = [
                        row["name"] for row in sorted(
                            (row for row in conn.execute("PRAGMA table_info(seedhub_catalog)") if row["pk"]),
                            key=lambda row: row["pk"],
                        )
                    ]
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "八仙！", "anime", 2),
                    )
                    count = conn.execute(
                        "SELECT COUNT(*) AS n FROM seedhub_catalog WHERE source_url=?", (source_url,)
                    ).fetchone()["n"]
        self.assertEqual(primary_key, ["source_url", "category"])
        self.assertEqual(count, 2)


class SeedHubCatalogueSearchTests(unittest.TestCase):
    def test_search_returns_imported_metadata_and_never_marks_it_as_playable(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        source_url = "https://www.seedhub.cc/movies/130096/"
        detail = {"title": "生化危机：爆发夜", "description": "公开目录简介", "mode": "metadata-only"}
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"), patch.object(seedhub, "_require_auth"):
                seedhub._initialize()
                with seedhub._connect() as conn:
                    conn.execute(
                        """INSERT INTO seedhub_catalog(source_url,title,category,poster_url,discovered_at,detail_json)
                           VALUES(?,?,?,?,?,?)""",
                        (source_url, "生化危机：爆发夜", "movies",
                         "https://www.seedhub.cc/poster.jpg", 123, json.dumps(detail, ensure_ascii=False)),
                    )
                result = seedhub.seedhub_search(q="生化危机", category=None, limit=20, authorization="Bearer test")
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["source_url"], source_url)
        self.assertEqual(result["items"][0]["detail"]["mode"], "metadata-only")
        self.assertNotIn("play_url", result["items"][0])
        self.assertNotIn("resource_url", result["items"][0])


class SeedHubSnapshotPurgeTests(unittest.TestCase):
    def test_legacy_catalogue_is_purged_only_when_deployment_flag_is_enabled(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import seedhub

        source_url = "https://www.seedhub.cc/movies/130096/"
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"):
                with patch.dict(os.environ, {"SEEDHUB_PURGE_LEGACY_CATALOG": "0"}):
                    seedhub._initialize()
                with seedhub._connect() as conn:
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "旧目录快照", "movies", 1),
                    )
                with patch.dict(os.environ, {"SEEDHUB_PURGE_LEGACY_CATALOG": "1"}):
                    seedhub._initialize()
                with seedhub._connect() as conn:
                    count = conn.execute("SELECT COUNT(*) AS n FROM seedhub_catalog").fetchone()["n"]
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "新写入的详情缓存", "movies", 2),
                    )
                with patch.dict(os.environ, {"SEEDHUB_PURGE_LEGACY_CATALOG": "1"}):
                    seedhub._initialize()
                with seedhub._connect() as conn:
                    retained = conn.execute("SELECT COUNT(*) AS n FROM seedhub_catalog").fetchone()["n"]
        self.assertEqual(count, 0)
        self.assertEqual(retained, 1)


class SeedHubCacheOnlyTests(unittest.TestCase):
    def test_cache_only_detail_does_not_trigger_live_fetch_when_not_enriched(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from fastapi import HTTPException
        import seedhub

        source_url = "https://www.seedhub.cc/movies/130096/"
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(seedhub, "DB_PATH", Path(directory) / "catalog.sqlite3"), patch.object(seedhub, "_require_auth"):
                seedhub._initialize()
                with seedhub._connect() as conn:
                    conn.execute(
                        "INSERT INTO seedhub_catalog(source_url,title,category,discovered_at) VALUES(?,?,?,?)",
                        (source_url, "谷雨", "series", 1),
                    )
                with patch.object(seedhub.Fetcher, "get", side_effect=AssertionError("cache-only must not crawl")):
                    with self.assertRaises(HTTPException) as raised:
                        seedhub.seedhub_detail(
                            source_url, category="series", cache_only=True, authorization="Bearer test"
                        )
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
