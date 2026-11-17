from __future__ import annotations

import pytest

from app.workflow_worker import WorkflowWorker


class _Nodes:
    def __init__(self, values: list[str]) -> None:
        self.values = values

    def getall(self) -> list[str]:
        return self.values


class _Title:
    def get(self) -> str:
        return "Test page"


class _Page:
    def __init__(self, url: str, links: list[str]) -> None:
        self.url = url
        self.links = links
        self.headers = {"content-type": "text/html; charset=utf-8"}
        self.status = 200

    def css(self, selector: str) -> _Nodes:
        if selector == "a::attr(href)":
            return _Nodes(self.links)
        return _Nodes([])

    def css_first(self, selector: str) -> _Title:
        return _Title()

    def get_all_text(self, strip: bool = True) -> str:
        return "A discovered public page"


@pytest.mark.asyncio
async def test_discover_site_links_is_bounded_and_stays_on_seed_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = "https://93.184.216.34/"
    child = "https://93.184.216.34/child"
    pages = {
        seed: _Page(
            seed,
            ["/child#section", "https://example.net/outside", "javascript:alert(1)"],
        ),
        child: _Page(child, ["/third"]),
    }
    fetched: list[str] = []

    def fetch(url: str, timeout: float) -> _Page:
        fetched.append(url)
        return pages[url]

    async def no_wait(seconds: float) -> None:
        return None

    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *a, **k: None)
    monkeypatch.setattr("app.workflow_worker.ScraplingAdapter.fetch_page", fetch)
    monkeypatch.setattr("app.workflow_worker.asyncio.sleep", no_wait)

    worker = WorkflowWorker("postgresql://unused", "test-worker")
    monkeypatch.setattr(worker.rules, "list_active_for_origin", lambda _url: [])
    result = await worker._discover_site_links({"urls": [seed], "max_pages": 2, "max_depth": 2})

    assert fetched == [seed, child]
    assert result["count"] == 2
    assert result["scope"] == "same_origin_only"
    assert result["visited_count"] == 2
    assert [item["url"] for item in result["items"]] == [seed, child]


@pytest.mark.asyncio
async def test_worker_tests_ai_generated_rule_on_fetched_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = "https://93.184.216.34/catalog"

    class RulePage:
        url = seed
        body = b"<html><article class='movie-card'>Movie A</article></html>"

        def get_all_text(self, strip: bool = True) -> str:
            return "Movie A"

    class FakePlanner:
        model = "test-model"

        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def generate_extraction_rule(
            self,
            _goal: str,
            _url: str,
            _html: str,
        ):
            from app.supervisor import ExtractionRule

            return ExtractionRule(
                mode="css",
                selector=".movie-card",
                rationale="Stable movie card class.",
            )

    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.fetch_page",
        lambda *_args, **_kwargs: RulePage(),
    )
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.extract",
        lambda *_args, **_kwargs: {"text": ["Movie A", "Movie B"], "count": 2},
    )
    monkeypatch.setattr("app.workflow_worker.SupervisorClient", FakePlanner)

    worker = WorkflowWorker("postgresql://unused", "test-worker")
    monkeypatch.setattr(
        worker.rules,
        "save_tested_rule",
        lambda **_kwargs: "rule-test-id",
    )
    result = await worker._generate_extraction_rule(
        {"page_url": seed, "goal": "Extract movie titles"}
    )

    assert result["test_passed"] is True
    assert result["rule_id"] == "rule-test-id"
    assert result["rule_status"] == "tested"
    assert result["selector"] == ".movie-card"
    assert result["match_count"] == 2
    assert result["verification_level"] == "live_page_selector_test"


@pytest.mark.asyncio
async def test_discovery_applies_only_explicitly_active_origin_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = "https://93.184.216.34/catalog"
    page = _Page(seed, [])
    active_rule = {
        "rule_id": "approved-rule",
        "version": 2,
        "goal": "Extract movie titles",
        "mode": "css",
        "selector": ".movie-card",
    }
    extracted_calls: list[str] = []

    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *a, **k: None)
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.fetch_page",
        lambda *_args, **_kwargs: page,
    )

    def extract(_page: _Page, selector: str, _mode: str) -> dict[str, object]:
        extracted_calls.append(selector)
        return {"text": ["Film A", "Film B"], "count": 2}

    monkeypatch.setattr("app.workflow_worker.ScraplingAdapter.extract", extract)
    worker = WorkflowWorker("postgresql://unused", "test-worker")
    monkeypatch.setattr(
        worker.rules,
        "list_active_for_origin",
        lambda _url: [active_rule],
    )
    monkeypatch.setattr(
        worker.rules,
        "record_execution",
        lambda *_args, **_kwargs: {
            "recorded": True,
            "failure_streak": 0,
            "auto_disabled": False,
        },
    )

    result = await worker._discover_site_links({"urls": [seed], "max_pages": 1})

    assert extracted_calls == [".movie-card"]
    assert result["items"][0]["rule_extractions"] == [
        {
            "rule_id": "approved-rule",
            "version": 2,
            "goal": "Extract movie titles",
            "values": ["Film A", "Film B"],
            "match_count": 2,
            "status": "matched",
            "failure_streak": 0,
            "auto_disabled": False,
        }
    ]


@pytest.mark.asyncio
async def test_autonomous_discovery_finds_public_sites_and_registers_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = "https://93.184.216.34/catalog"
    page = _Page(
        catalog,
        [
            "https://93.184.216.35/",
            "https://93.184.216.36/watch",
            "http://169.254.169.254/latest/meta-data/",
            "javascript:alert(1)",
        ],
    )
    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_a, **_k: None)
    monkeypatch.setattr("app.workflow_worker.ScraplingAdapter.fetch_page", lambda *_a, **_k: page)

    worker = WorkflowWorker("postgresql://unused", "test-worker")

    async def discover(payload: dict[str, object]) -> dict[str, object]:
        url = payload["urls"][0]
        return {
            "count": 1,
            "errors": [],
            "items": [
                {
                    "url": url,
                    "title": "Public film",
                    "media_urls": ["https://93.184.216.35/movie.m3u8"],
                }
            ],
        }

    async def generate(payload: dict[str, object]) -> dict[str, object]:
        return {"rule_id": "tested-rule", "rule_status": "tested", "test_passed": True}

    async def register(payload: dict[str, object]) -> dict[str, object]:
        assert payload["_workflow_id"] == "workflow-test"
        return {"candidate_ids": ["candidate-1"], "count": 1}

    monkeypatch.setattr(worker.rules, "list_active_for_origin", lambda _url: [])
    monkeypatch.setattr(worker, "_ai_supervisor_discover", discover)
    monkeypatch.setattr(worker, "_generate_extraction_rule", generate)
    monkeypatch.setattr(worker, "_register_candidates", register)

    result = await worker._autonomous_site_discovery(
        {
            "catalog_urls": [catalog],
            "max_sites": 5,
            "_workflow_id": "workflow-test",
        }
    )

    assert result["discovered_site_count"] == 2
    assert result["scanned_site_count"] == 2
    assert result["candidate_count"] == 2
    assert result["review_gate"].startswith("resources_remain_pending_human_review")
    assert all(site["status"] == "candidates_registered" for site in result["sites"])
    assert all(site["review_status"] == "candidate_only" for site in result["sites"])


@pytest.mark.asyncio
async def test_autonomous_discovery_proposes_replacement_after_active_rule_breaks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = "https://93.184.216.34/catalog"
    page = _Page(catalog, ["https://93.184.216.35/"])
    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_a, **_k: None)
    monkeypatch.setattr("app.workflow_worker.ScraplingAdapter.fetch_page", lambda *_a, **_k: page)
    worker = WorkflowWorker("postgresql://unused", "test-worker")
    monkeypatch.setattr(
        worker.rules,
        "list_active_for_origin",
        lambda _url: [{"rule_id": "old-rule"}],
    )

    async def discover(_payload: dict[str, object]) -> dict[str, object]:
        return {
            "count": 1,
            "errors": [],
            "items": [
                {
                    "url": "https://93.184.216.35/",
                    "media_urls": ["https://93.184.216.35/film.m3u8"],
                    "rule_extractions": [{"status": "no_matches", "auto_disabled": True}],
                }
            ],
        }

    async def generate(_payload: dict[str, object]) -> dict[str, object]:
        return {"rule_id": "replacement-rule", "rule_status": "tested", "test_passed": True}

    async def register(_payload: dict[str, object]) -> dict[str, object]:
        return {"candidate_ids": ["candidate-2"], "count": 1}

    monkeypatch.setattr(worker, "_ai_supervisor_discover", discover)
    monkeypatch.setattr(worker, "_generate_extraction_rule", generate)
    monkeypatch.setattr(worker, "_register_candidates", register)
    result = await worker._autonomous_site_discovery({"catalog_urls": [catalog], "max_sites": 1})

    site = result["sites"][0]
    assert site["rule"]["rule_id"] == "replacement-rule"
    assert site["rule_repair_status"] == "replacement_tested_pending_approval"
    assert site["status"] == "candidates_registered"


@pytest.mark.asyncio
async def test_hls_variant_playlists_are_checked_for_encryption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root_url = "https://93.184.216.34/master.m3u8"
    variant_url = "https://93.184.216.34/variant.m3u8"
    root = type("Page", (), {"url": root_url, "status": 200, "body": b""})()
    variant = type(
        "Page",
        (),
        {
            "url": variant_url,
            "status": 200,
            "body": b"\n".join([b"#EXTM3U", b'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"']) + b"\n",
        },
    )()
    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.fetch_page",
        lambda url, *_a, **_k: variant if url == variant_url else root,
    )
    worker = WorkflowWorker("postgresql://unused", "test-worker")
    result = await worker._inspect_hls_protection(
        root_url,
        "\n".join(["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1000000", "variant.m3u8"]),
    )
    assert result["protection_state"] == "protected_or_encrypted"
    assert result["protection_methods"] == ["SAMPLE-AES"]


@pytest.mark.asyncio
async def test_hls_cross_origin_variant_is_not_fetched_or_approved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root_url = "https://93.184.216.34/master.m3u8"
    calls: list[str] = []
    monkeypatch.setattr("app.workflow_worker.ensure_robots_allowed", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "app.workflow_worker.ScraplingAdapter.fetch_page",
        lambda url, *_a, **_k: calls.append(url),
    )
    worker = WorkflowWorker("postgresql://unused", "test-worker")
    result = await worker._inspect_hls_protection(
        root_url,
        "\n".join(
            ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1000000", "https://example.net/variant.m3u8"]
        ),
    )
    assert result["protection_state"] == "unknown"
    assert calls == []
