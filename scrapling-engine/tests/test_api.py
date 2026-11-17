from unittest.mock import Mock

import pytest
from cssselect.parser import SelectorSyntaxError
from fastapi.testclient import TestClient
from lxml.etree import XPathError
from pydantic import SecretStr

from app.main import WorkflowNodeRequest, app
from app.scraper import ScraplingAdapter

client = TestClient(app)


def test_candidate_and_rule_approval_routes_require_api_key(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.main.settings.api_key",
        SecretStr("review-gate-test-key-0123456789abcdef"),
    )

    protected_routes = [
        (
            "/v1/candidates/candidate-123/review",
            {"decision": "approved", "reviewer_id": "reviewer", "note": "reviewed"},
        ),
        (
            "/v1/rules/rule-123/activate",
            {"reviewer_id": "reviewer", "note": "reviewed"},
        ),
        (
            "/v1/rules/rule-123/disable",
            {"reviewer_id": "reviewer", "note": "disabled"},
        ),
        (
            "/v1/autonomous/discover",
            {"catalog_urls": ["https://example.com/directory"], "max_sites": 2},
        ),
    ]

    for path, payload in protected_routes:
        assert client.post(path, json=payload).status_code == 401
        assert (
            client.post(
                path,
                json=payload,
                headers={"X-API-Key": "incorrect-key"},
            ).status_code
            == 401
        )

        authorized = client.post(
            path,
            json=payload,
            headers={"X-API-Key": "review-gate-test-key-0123456789abcdef"},
        )
        # The request passes the authentication middleware. The endpoint may
        # then return 404/409/501 depending on the configured test database.
        assert authorized.status_code != 401


def test_health_reports_phase_two() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["engine"] == "scrapling"
    assert response.json()["phase"] == "2"


def test_candidate_review_rejects_client_supplied_reviewer_identity(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.main.settings.api_key",
        SecretStr("review-gate-test-key-0123456789abcdef"),
    )
    response = client.post(
        "/v1/candidates/candidate-123/review",
        json={"decision": "rejected", "note": "", "reviewer_id": "attacker"},
        headers={
            "X-API-Key": "review-gate-test-key-0123456789abcdef",
            "X-LibreTV-Reviewer-Sub": "cf-access-0123456789abcdef",
        },
    )
    assert response.status_code == 422


def test_capabilities_distinguish_planned_features() -> None:
    response = client.get("/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert "http_fetch" in body["implemented"]
    assert "xpath_extraction" in body["implemented"]
    assert (
        "bounded_same_origin_recursive_discovery" in body["implemented"]
        or "recursive_discovery_requires_postgresql_worker" in body["implemented"]
    )
    assert "unrestricted_cross_origin_discovery" in body["planned"]


def test_fetch_rejects_localhost_before_network_request() -> None:
    response = client.post("/v1/fetch", json={"url": "http://127.0.0.1/"})
    assert response.status_code == 400


def test_fetch_requires_selector_for_structured_modes() -> None:
    response = client.post(
        "/v1/fetch",
        json={"url": "https://example.com/", "mode": "css"},
    )
    assert response.status_code == 422


def test_fetch_uses_adapter_and_returns_extraction(monkeypatch) -> None:
    page = Mock()
    monkeypatch.setattr(
        "app.main.validate_public_http_url",
        lambda url: url,
    )
    monkeypatch.setattr(
        "app.main.ensure_robots_allowed",
        lambda url, timeout: None,
    )
    monkeypatch.setattr(
        "app.main.ScraplingAdapter.fetch_page",
        lambda url, timeout: page,
    )
    monkeypatch.setattr(
        "app.main.ScraplingAdapter.extract",
        lambda page, selector, mode, adaptive_action=None: {
            "title": "fixture",
            "text": ["real adapter fixture"],
        },
    )
    response = client.post(
        "/v1/fetch",
        json={"url": "https://example.com/", "mode": "css", "selector": "h1"},
    )
    assert response.status_code == 200
    assert response.json()["result"]["title"] == "fixture"


def test_adapter_extracts_css_and_metadata() -> None:
    heading = Mock()
    heading.get_all_text.return_value = "Example heading"
    title = Mock()
    title.get.return_value = "Example title"
    page = Mock()
    page.get_all_text.return_value = "Example heading body"
    page.css.return_value = [heading]
    page.css_first.return_value = title
    page.status = 200
    page.url = "https://example.com/"
    page.markdown.return_value = "# Example"

    result = ScraplingAdapter.extract(page, "h1", "css")

    assert result["text"] == ["Example heading"]
    assert result["title"] == "Example title"
    assert result["markdown"] == "# Example"
    assert result["status"] == 200


def test_adapter_supports_xpath_and_regex() -> None:
    node = Mock()
    node.get_all_text.return_value = "Chapter 12"
    page = Mock()
    page.get_all_text.return_value = "Chapter 12 and Chapter 13"
    page.xpath.return_value = [node]
    page.css_first.return_value = None
    page.markdown.return_value = None

    xpath_result = ScraplingAdapter.extract(page, "//h2", "xpath")
    regex_result = ScraplingAdapter.extract(page, r"Chapter (\d+)", "regex")

    assert xpath_result["text"] == ["Chapter 12"]
    assert regex_result["text"] == ["12", "13"]
    assert regex_result["count"] == 2


def test_spider_rejects_private_seed_urls() -> None:
    response = client.post(
        "/v1/spider",
        json={"urls": ["http://127.0.0.1/"]},
    )
    assert response.status_code == 400


def test_spider_runs_validated_seed_urls(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.main.validate_public_http_url",
        lambda url: url,
    )
    monkeypatch.setattr(
        "app.main.ScraplingSpiderAdapter.crawl",
        lambda urls, crawldir=None: {
            "items": [{"url": urls[0], "title": "fixture"}],
            "completed": True,
            "paused": False,
            "stats": {"requests_count": 1},
        },
    )

    response = client.post(
        "/v1/spider",
        json={"urls": ["https://example.com/", "https://example.com/"]},
    )

    assert response.status_code == 200
    assert response.json()["result"]["stats"]["requests_count"] == 1
    assert len(response.json()["result"]["items"]) == 1


def test_spider_task_id_enables_checkpoint_directory(monkeypatch, tmp_path) -> None:
    captured = {}
    monkeypatch.setattr(
        "app.main.validate_public_http_url",
        lambda url: url,
    )
    monkeypatch.setattr("app.main.settings.crawl_data_dir", str(tmp_path))

    def fake_crawl(urls, crawldir=None):
        captured["urls"] = urls
        captured["crawldir"] = crawldir
        return {
            "items": [],
            "completed": True,
            "paused": False,
            "stats": {"requests_count": 0},
        }

    monkeypatch.setattr("app.main.ScraplingSpiderAdapter.crawl", fake_crawl)
    response = client.post(
        "/v1/spider",
        json={"urls": ["https://example.com/"], "task_id": "weekly_scan_01"},
    )

    assert response.status_code == 200
    assert response.json()["checkpoint_enabled"] is True
    assert captured["crawldir"] == tmp_path / "weekly_scan_01"
    assert captured["crawldir"].is_dir()
    assert (captured["crawldir"] / "libretv-manifest.json").is_file()

    mismatch = client.post(
        "/v1/spider",
        json={"urls": ["https://different.example/"], "task_id": "weekly_scan_01"},
    )
    assert mismatch.status_code == 409


def test_spider_rejects_unsafe_task_id() -> None:
    response = client.post(
        "/v1/spider",
        json={"urls": ["https://example.com/"], "task_id": "../escape"},
    )
    assert response.status_code == 422


def test_fetch_requires_action_for_adaptive_modes() -> None:
    response = client.post(
        "/v1/fetch",
        json={
            "url": "https://example.com/",
            "mode": "adaptive_css",
            "selector": ".headline",
        },
    )
    assert response.status_code == 422


def test_adapter_supports_adaptive_css_save_and_relocate() -> None:
    heading = Mock()
    heading.get_all_text.return_value = "Saved heading"
    page = Mock()
    page.get_all_text.return_value = "Saved heading"
    page.css.return_value = [heading]
    page.css_first.return_value = None
    page.markdown.return_value = None

    saved = ScraplingAdapter.extract(
        page,
        ".headline",
        "adaptive_css",
        adaptive_action="save",
    )
    page.css.assert_called_with(".headline", auto_save=True)
    assert saved["text"] == ["Saved heading"]

    relocated = ScraplingAdapter.extract(
        page,
        ".headline",
        "adaptive_css",
        adaptive_action="relocate",
    )
    page.css.assert_called_with(".headline", adaptive=True)
    assert relocated["adaptive_action"] == "relocate"


def test_adapter_supports_adaptive_xpath_relocation() -> None:
    node = Mock()
    node.get_all_text.return_value = "Adaptive result"
    page = Mock()
    page.get_all_text.return_value = "Adaptive result"
    page.xpath.return_value = [node]
    page.css_first.return_value = None
    page.markdown.return_value = None

    result = ScraplingAdapter.extract(
        page,
        "//h2",
        "adaptive_xpath",
        adaptive_action="relocate",
    )

    page.xpath.assert_called_with("//h2", adaptive=True)
    assert result["text"] == ["Adaptive result"]


def test_adapter_converts_invalid_css_and_xpath_to_validation_errors() -> None:
    page = Mock()
    page.get_all_text.return_value = "fixture"
    page.css.side_effect = SelectorSyntaxError("bad css")
    page.xpath.side_effect = XPathError("bad xpath")

    with pytest.raises(ValueError, match="Invalid CSS selector"):
        ScraplingAdapter.extract(page, "???", "css")
    with pytest.raises(ValueError, match="Invalid XPath expression"):
        ScraplingAdapter.extract(page, "//*[", "xpath")


def test_rule_activation_records_human_actor(monkeypatch) -> None:
    class FakeRuleStore:
        def __init__(self) -> None:
            self.action = None

        def set_status(self, rule_id, status, actor_id, note):
            self.action = (rule_id, status, actor_id, note)
            return True

        def get_rule(self, rule_id):
            return {"rule_id": rule_id, "status": "active"}

    store = FakeRuleStore()
    monkeypatch.setattr("app.main.rule_store", store)
    response = client.post(
        "/v1/rules/rule-123/activate",
        json={"note": "Selector reviewed"},
        headers={"X-LibreTV-Reviewer-Sub": "site-admin"},
    )
    assert response.status_code == 200
    assert store.action == ("rule-123", "active", "site-admin", "Selector reviewed")


def test_workflow_schema_exposes_isolated_media_probe_node() -> None:
    node = WorkflowNodeRequest(
        node_id="probe-media",
        node_type="probe_local_media_file",
        input={"local_path": "/tmp/libretv-media-probe/movie.mp4"},
    )
    assert node.node_type == "probe_local_media_file"


def test_workflow_schema_accepts_autonomous_discovery_and_media_probe_nodes() -> None:
    autonomous = WorkflowNodeRequest(
        node_id="discover-sites",
        node_type="autonomous_site_discovery",
        input={"catalog_urls": ["https://example.com/directory"]},
    )
    probe = WorkflowNodeRequest(
        node_id="probe-media",
        node_type="probe_media_candidates",
    )
    assert autonomous.node_type == "autonomous_site_discovery"
    assert probe.node_type == "probe_media_candidates"
