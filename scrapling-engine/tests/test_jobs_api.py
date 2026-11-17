from __future__ import annotations

import asyncio
from dataclasses import dataclass

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app import main
from app.config import is_loopback_host
from app.job_store import JobStore


def _use_test_store(monkeypatch, tmp_path) -> JobStore:
    store = JobStore(str(tmp_path / "jobs.sqlite3"))
    store.initialize()
    monkeypatch.setattr(main, "job_store", store)
    monkeypatch.setattr(main.settings, "database_url", None)
    monkeypatch.setattr(main, "validate_public_http_url", lambda url: url)
    monkeypatch.setattr(main, "_schedule_job", lambda task_id: None)
    monkeypatch.setattr(main.settings, "crawl_data_dir", str(tmp_path / "crawls"))
    return store


def test_job_api_persists_and_rejects_task_id_seed_mismatch(monkeypatch, tmp_path) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    client = TestClient(main.app)

    response = client.post(
        "/v1/jobs",
        json={"task_id": "job_api_01", "urls": ["https://example.com/"]},
    )
    assert response.status_code == 202
    assert response.json()["job"]["status"] == "queued"

    status = client.get("/v1/jobs/job_api_01")
    assert status.status_code == 200
    assert status.json()["job"]["seeds"] == ["https://example.com/"]

    mismatch = client.post(
        "/v1/jobs",
        json={"task_id": "job_api_01", "urls": ["https://different.example/"]},
    )
    assert mismatch.status_code == 409
    assert store.get("job_api_01") is not None


def test_job_pause_and_resume_controls(monkeypatch, tmp_path) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    client = TestClient(main.app)
    checkpoint = tmp_path / "crawls" / "job_api_02"
    checkpoint.mkdir(parents=True)
    (checkpoint / "checkpoint.bin").write_bytes(b"checkpoint")
    (checkpoint / "libretv-manifest.json").write_text(
        '{"task_id": "job_api_02", "seeds": ["https://example.com/"]}',
        encoding="utf-8",
    )

    assert store.create(
        "job_api_02",
        ["https://example.com/"],
        str(checkpoint),
    )
    store.update("job_api_02", "running")

    class FakeSpider:
        paused = False

        def pause(self) -> None:
            self.paused = True

    spider = FakeSpider()
    monkeypatch.setitem(main._active_spiders, "job_api_02", spider)

    pause = client.post("/v1/jobs/job_api_02/pause")
    assert pause.status_code == 200
    assert spider.paused is True
    assert store.get("job_api_02")["status"] == "pausing"

    store.update("job_api_02", "paused")
    resume = client.post("/v1/jobs/job_api_02/resume")
    assert resume.status_code == 202
    assert store.get("job_api_02")["status"] == "queued"


def test_job_runner_persists_results_and_item_events(monkeypatch, tmp_path) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    assert store.create(
        "job_runner_01",
        ["https://example.com/"],
        str(tmp_path / "job_runner_01"),
    )

    previous_item = {
        "url": "https://example.com/previous",
        "title": "previous",
        "text": "already saved",
    }
    store.add_result("job_runner_01", previous_item)
    store.update(
        "job_runner_01",
        "paused",
        started_at="2026-11-08T12:00:00+00:00",
    )

    @dataclass
    class FakeStats:
        requests_count: int = 1

    class FakeSpider:
        stats = FakeStats()

        async def stream(self):
            yield previous_item
            yield {
                "url": "https://example.com/new",
                "title": "fixture",
                "text": "fixture body",
            }

    monkeypatch.setattr(
        main.ScraplingSpiderAdapter,
        "create",
        lambda urls, crawldir: FakeSpider(),
    )

    asyncio.run(main._run_job("job_runner_01"))

    job = store.get("job_runner_01")
    assert job is not None
    assert job["status"] == "completed"
    assert job["started_at"] == "2026-11-08T12:00:00+00:00"
    assert [item["title"] for item in job["result"]["items"]] == [
        "previous",
        "fixture",
    ]
    assert len(store.get_results("job_runner_01")) == 2
    assert any(event["type"] == "item" for event in store.events_after("job_runner_01", 0))


def test_job_event_stream_replays_persisted_events(monkeypatch, tmp_path) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    assert store.create(
        "job_events_01",
        ["https://example.com/"],
        str(tmp_path / "job_events_01"),
    )
    store.update("job_events_01", "completed", finished_at="2026-11-09T00:00:00+00:00")

    response = TestClient(main.app).get("/v1/jobs/job_events_01/events")

    assert response.status_code == 200
    assert "event: queued" in response.text
    assert "event: completed" in response.text


def test_legacy_and_managed_apis_cannot_share_active_task_id(
    monkeypatch,
    tmp_path,
) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    client = TestClient(main.app)

    monkeypatch.setattr(main, "_legacy_task_ids", {"legacy_busy"})
    managed = client.post(
        "/v1/jobs",
        json={"task_id": "legacy_busy", "urls": ["https://example.com/"]},
    )
    assert managed.status_code == 409

    assert store.create(
        "managed_busy",
        ["https://example.com/"],
        str(tmp_path / "managed_busy"),
    )
    legacy = client.post(
        "/v1/spider",
        json={"task_id": "managed_busy", "urls": ["https://example.com/"]},
    )
    assert legacy.status_code == 409


def test_job_runner_marks_pause_without_checkpoint_as_interrupted(
    monkeypatch,
    tmp_path,
) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    checkpoint = tmp_path / "crawls" / "job_pause_no_checkpoint"
    checkpoint.mkdir(parents=True)
    (checkpoint / "libretv-manifest.json").write_text(
        '{"task_id": "job_pause_no_checkpoint", "seeds": '
        '["https://example.com/one", "https://example.com/two"]}',
        encoding="utf-8",
    )
    assert store.create(
        "job_pause_no_checkpoint",
        ["https://example.com/one", "https://example.com/two"],
        str(checkpoint),
    )

    @dataclass
    class FakeStats:
        requests_count: int = 1

    class FakeSpider:
        stats = FakeStats()

        async def stream(self):
            store.update("job_pause_no_checkpoint", "pausing")
            yield {
                "url": "https://example.com/one",
                "title": "one",
                "text": "partial",
            }

    monkeypatch.setattr(
        main.ScraplingSpiderAdapter,
        "create",
        lambda urls, crawldir: FakeSpider(),
    )

    asyncio.run(main._run_job("job_pause_no_checkpoint"))

    job = store.get("job_pause_no_checkpoint")
    assert job is not None
    assert job["status"] == "interrupted"
    assert job["error"] == "Pause ended without a persisted checkpoint."
    assert len(store.get_results("job_pause_no_checkpoint")) == 1


def test_remote_api_key_protects_v1_routes_but_not_health(monkeypatch) -> None:
    monkeypatch.setattr(main.settings, "api_key", SecretStr("test-secret"))
    client = TestClient(main.app)

    denied = client.get("/v1/jobs/missing")
    assert denied.status_code == 401

    allowed = client.get(
        "/v1/jobs/missing",
        headers={"X-API-Key": "test-secret"},
    )
    assert allowed.status_code == 404

    health = client.get("/health")
    assert health.status_code == 200


def test_loopback_host_detection() -> None:
    assert is_loopback_host("127.0.0.1")
    assert is_loopback_host("::1")
    assert is_loopback_host("localhost")
    assert not is_loopback_host("0.0.0.0")
    assert not is_loopback_host("192.0.2.10")


def test_startup_reschedules_persisted_queued_jobs(monkeypatch, tmp_path) -> None:
    store = _use_test_store(monkeypatch, tmp_path)
    assert store.create(
        "queued_after_restart",
        ["https://example.com/"],
        str(tmp_path / "queued_after_restart"),
    )
    scheduled: list[str] = []
    monkeypatch.setattr(main, "_schedule_job", scheduled.append)

    with TestClient(main.app):
        pass

    assert scheduled == ["queued_after_restart"]
