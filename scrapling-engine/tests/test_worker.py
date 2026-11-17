from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from app.postgres_job_store import PostgresJobStore
from app.worker import CrawlWorker, LeaseLost


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_worker_fences_result_and_completion_writes_to_current_lease_owner() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresJobStore(database_url)
    store.initialize()
    task_id = "worker_fence_" + uuid.uuid4().hex
    worker = CrawlWorker(database_url, "worker-one", lease_seconds=30)

    try:
        assert store.create(task_id, ["https://example.com/"], "/tmp/" + task_id)
        claimed = store.claim_next(worker.worker_id, lease_seconds=30)
        assert claimed is not None and claimed["task_id"] == task_id

        worker._fenced_result(
            task_id,
            {"url": "https://example.com/", "title": "Example Domain"},
        )
        assert store.get_results(task_id)[0]["title"] == "Example Domain"

        other_worker = CrawlWorker(database_url, "worker-two", lease_seconds=30)
        with pytest.raises(LeaseLost):
            other_worker._fenced_result(
                task_id,
                {"url": "https://attacker.invalid/", "title": "Must not persist"},
            )

        worker._fenced_finish(
            task_id,
            "completed",
            {"items": store.get_results(task_id), "completed": True},
        )
        job = store.get(task_id)
        assert job is not None
        assert job["status"] == "completed"
        assert job["lease_owner"] is None
        assert [event["type"] for event in store.events_after(task_id, 0)] == [
            "queued",
            "claimed",
            "item",
            "completed",
        ]
    finally:
        with psycopg.connect(database_url) as db:
            db.execute("DELETE FROM crawl_jobs WHERE task_id = %s", (task_id,))


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_expired_worker_lease_is_reclaimed_and_old_worker_is_fenced() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresJobStore(database_url)
    store.initialize()
    task_id = "worker_reclaim_" + uuid.uuid4().hex
    first = CrawlWorker(database_url, "worker-one", lease_seconds=30)
    second = CrawlWorker(database_url, "worker-two", lease_seconds=30)

    try:
        assert store.create(task_id, ["https://example.com/"], "/tmp/" + task_id)
        claimed = store.claim_next(first.worker_id, lease_seconds=30)
        assert claimed is not None and claimed["lease_owner"] == first.worker_id
        with psycopg.connect(database_url) as db:
            db.execute(
                "UPDATE crawl_jobs SET lease_expires_at = NOW() - INTERVAL '1 second' "
                "WHERE task_id = %s",
                (task_id,),
            )

        reclaimed = store.claim_next(second.worker_id, lease_seconds=30)
        assert reclaimed is not None and reclaimed["lease_owner"] == second.worker_id
        with pytest.raises(LeaseLost):
            first._fenced_result(task_id, {"url": "https://example.com/old"})
        second._fenced_result(task_id, {"url": "https://example.com/new"})
        assert [item["url"] for item in store.get_results(task_id)] == ["https://example.com/new"]
    finally:
        with psycopg.connect(database_url) as db:
            db.execute("DELETE FROM crawl_jobs WHERE task_id = %s", (task_id,))


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_worker_stops_persisting_results_after_pause_is_requested() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresJobStore(database_url)
    store.initialize()
    task_id = "worker_pause_fence_" + uuid.uuid4().hex
    worker = CrawlWorker(database_url, "worker-pause", lease_seconds=30)

    try:
        assert store.create(task_id, ["https://example.com/"], "/tmp/" + task_id)
        assert store.claim_next(worker.worker_id, lease_seconds=30) is not None
        assert store.request_control(task_id, "pause")
        persisted = worker._fenced_result(
            task_id,
            {"url": "https://example.com/late", "title": "Must not persist"},
        )
        assert persisted is False
        assert store.get_results(task_id) == []
        worker._fenced_finish(
            task_id,
            "paused",
            {"items": [], "completed": False, "paused": True},
        )
        assert store.get(task_id)["status"] == "paused"
    finally:
        with psycopg.connect(database_url) as db:
            db.execute("DELETE FROM crawl_jobs WHERE task_id = %s", (task_id,))


def test_crawl_worker_uses_unique_lease_identity_per_process() -> None:
    first = CrawlWorker("postgresql://unused", "crawl-worker-1")
    second = CrawlWorker("postgresql://unused", "crawl-worker-1")

    assert first.worker_id.startswith("crawl-worker-1:")
    assert second.worker_id.startswith("crawl-worker-1:")
    assert first.worker_id != second.worker_id
