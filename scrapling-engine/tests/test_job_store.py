from __future__ import annotations

from app.job_store import JobStore


def test_job_store_persists_jobs_and_events(tmp_path) -> None:
    store = JobStore(str(tmp_path / "jobs.sqlite3"))
    store.initialize()

    assert store.create("job_01", ["https://example.com/"], str(tmp_path / "job_01"))
    assert not store.create("job_01", ["https://example.com/"], str(tmp_path / "job_01"))

    job = store.get("job_01")
    assert job is not None
    assert job["status"] == "queued"
    assert job["seeds"] == ["https://example.com/"]

    store.update("job_01", "running", started_at="2026-11-09T00:00:00+00:00")
    store.add_event("job_01", "item", {"url": "https://example.com/", "count": 1})

    events = store.events_after("job_01", 0)
    assert [event["type"] for event in events] == ["queued", "running", "item"]
    assert events[-1]["payload"]["count"] == 1


def test_job_store_recovers_running_jobs_but_preserves_queued_jobs(tmp_path) -> None:
    store = JobStore(str(tmp_path / "jobs.sqlite3"))
    store.initialize()
    store.create("queued_01", ["https://queued.example/"], str(tmp_path / "queued_01"))
    store.create("running_01", ["https://running.example/"], str(tmp_path / "running_01"))
    store.update("running_01", "running")

    assert store.recover_interrupted() == ["running_01"]
    queued = store.get("queued_01")
    interrupted = store.get("running_01")
    assert queued is not None and queued["status"] == "queued"
    assert interrupted is not None and interrupted["status"] == "interrupted"
    assert [job["task_id"] for job in store.list_queued()] == ["queued_01"]
    assert store.events_after("running_01", 0)[-1]["type"] == "interrupted"
    assert store.events_after("running_01", 0)[-1]["payload"]["reason"] == "service_restart"
