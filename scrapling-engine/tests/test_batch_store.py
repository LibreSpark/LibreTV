from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from app.batch_store import BatchIdempotencyConflict, PostgresBatchStore
from app.candidate_store import PostgresCandidateStore
from app.workflow_store import PostgresWorkflowStore


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"), reason="PostgreSQL integration database is not configured"
)
def test_batch_persists_and_tracks_one_thousand_independent_workflows() -> None:
    database_url = os.environ["DATABASE_URL"]
    workflows = PostgresWorkflowStore(database_url)
    candidates = PostgresCandidateStore(database_url)
    batches = PostgresBatchStore(database_url, workflows)
    workflows.initialize()
    candidates.initialize()
    batches.initialize()
    key = "batch-test-" + uuid.uuid4().hex
    urls = [f"https://example.com/catalog/{index}" for index in range(1000)]
    request_hash = batches.request_hash(urls, "public discovery")
    batch_id = None

    try:
        created = batches.create_batch(key, request_hash, urls, "public discovery")
        batch_id = created["batch_id"]
        assert created["created"] is True
        duplicate = batches.create_batch(key, request_hash, urls, "public discovery")
        assert duplicate == {"batch_id": batch_id, "created": False}
        with pytest.raises(BatchIdempotencyConflict):
            batches.create_batch(
                key,
                batches.request_hash(urls[:-1], "public discovery"),
                urls[:-1],
                "public discovery",
            )

        summary = batches.get_batch(batch_id, limit=25, offset=0)
        assert summary is not None
        assert summary["total"] == 1000
        assert summary["queued"] == 1000
        assert summary["active"] == 1000
        assert len(summary["tasks"]) == 25
        assert batches.global_summary()["total"] == 1000
        with psycopg.connect(database_url) as db:
            db.execute(
                "UPDATE resource_task_batches SET media_probe_budget_bytes = 8192 "
                "WHERE batch_id = %s",
                (batch_id,),
            )
        assert batches.reserve_media_probe_bytes(batch_id, "probe-attempt-1", 4096)
        assert batches.reserve_media_probe_bytes(batch_id, "probe-attempt-2", 4096)
        assert not batches.reserve_media_probe_bytes(batch_id, "probe-attempt-3", 4096)
        assert batches.adjust_media_probe_reservation(batch_id, "probe-attempt-1", 1024)
        budgeted = batches.get_batch(batch_id, limit=1, offset=0)
        assert budgeted is not None
        assert budgeted["media_probe_bytes"] == 5120
        assert budgeted["media_probe_budget_bytes"] == 8192
        global_budget = batches.global_summary()
        assert global_budget["media_probe_bytes"] == 5120
        assert global_budget["media_probe_budget_bytes"] == 8192
        listed = batches.list_batches(limit=10)
        assert any(item["batch_id"] == batch_id and item["total"] == 1000 for item in listed)

        first_page = batches.events_after(batch_id, last_id=0, limit=1000)
        second_page = batches.events_after(batch_id, last_id=first_page[-1]["id"], limit=1000)
        assert first_page
        assert first_page[0]["type"] == "workflow_created"
        assert any(event["type"] == "batch_created" for event in second_page)
    finally:
        if batch_id:
            with psycopg.connect(database_url) as db:
                db.execute("DELETE FROM resource_task_batches WHERE batch_id = %s", (batch_id,))
