from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from app.workflow_store import PostgresWorkflowStore, WorkflowDefinitionError
from app.workflow_worker import WorkflowWorker


def test_workflow_store_rejects_cycles_and_unknown_edges() -> None:
    nodes = [
        {"node_id": "discover", "node_type": "discover"},
        {"node_id": "crawl", "node_type": "crawl"},
    ]
    with pytest.raises(WorkflowDefinitionError):
        PostgresWorkflowStore._validate_graph(nodes, [("discover", "crawl"), ("crawl", "discover")])
    with pytest.raises(WorkflowDefinitionError):
        PostgresWorkflowStore._validate_graph(nodes, [("missing", "crawl")])


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_postgres_workflow_dag_claims_dependencies_and_retries_durably() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresWorkflowStore(database_url)
    store.initialize()
    workflow_id = "dag_test_" + uuid.uuid4().hex
    nodes = [
        {"node_id": "discover", "node_type": "discover", "max_attempts": 2},
        {"node_id": "analyze", "node_type": "analyze", "max_attempts": 2},
        {"node_id": "candidate", "node_type": "candidate", "max_attempts": 1},
    ]
    edges = [("discover", "analyze"), ("analyze", "candidate")]

    try:
        assert store.create_workflow(workflow_id, nodes, edges, {"source": "test"})
        assert not store.create_workflow(workflow_id, nodes, edges)
        assert any(item["workflow_id"] == workflow_id for item in store.list_workflows(limit=200))
        first = store.claim_ready_node("worker-a", lease_seconds=30, workflow_id=workflow_id)
        assert first is not None
        assert first["node_id"] == "discover"
        assert first["workflow_input"] == {"source": "test"}
        assert store.claim_ready_node("worker-b", lease_seconds=30, workflow_id=workflow_id) is None
        assert store.save_node_checkpoint(
            workflow_id,
            "discover",
            "worker-a",
            first["lease_generation"],
            {"visited": ["https://example.com/start"]},
        )
        assert store.save_node_checkpoint(
            workflow_id,
            "discover",
            "worker-a",
            first["lease_generation"],
            {"visited": ["https://example.com/"], "items": []},
        )
        with psycopg.connect(database_url) as db:
            db.execute(
                "UPDATE resource_workflow_nodes "
                "SET lease_expires_at = NOW() - INTERVAL '1 second' "
                "WHERE workflow_id = %s AND node_id = 'discover'",
                (workflow_id,),
            )
        assert not store.heartbeat_node(
            workflow_id,
            "discover",
            "worker-a",
            first["lease_generation"],
            lease_seconds=30,
        )
        recovered = store.claim_ready_node("worker-b", lease_seconds=30, workflow_id=workflow_id)
        assert recovered is not None
        assert recovered["node_id"] == "discover"
        assert recovered["attempt_count"] == 2
        assert recovered["checkpoint"] == {
            "visited": ["https://example.com/"],
            "items": [],
        }
        assert not store.save_node_checkpoint(
            workflow_id,
            "discover",
            "worker-a",
            first["lease_generation"],
            {"visited": ["https://stale.example/"]},
        )
        assert not store.complete_node(
            workflow_id,
            "discover",
            "worker-a",
            first["lease_generation"],
            {"sites": ["stale.example"]},
        )
        assert store.complete_node(
            workflow_id,
            "discover",
            "worker-b",
            recovered["lease_generation"],
            {"sites": ["example.com"]},
        )

        second = store.claim_ready_node("worker-c", lease_seconds=30, workflow_id=workflow_id)
        assert second is not None
        assert second["node_id"] == "analyze"
        assert second["dependencies"]["discover"] == {"sites": ["example.com"]}
        assert (
            store.fail_node(
                workflow_id,
                "analyze",
                "worker-c",
                second["lease_generation"],
                "temporary model timeout",
                0,
            )
            == "retry_wait"
        )
        retried = store.claim_ready_node("worker-d", lease_seconds=30, workflow_id=workflow_id)
        assert retried is not None
        assert retried["node_id"] == "analyze"
        assert retried["attempt_count"] == 2
        assert (
            store.fail_node(
                workflow_id,
                "analyze",
                "worker-d",
                retried["lease_generation"],
                "second model timeout",
                0,
            )
            == "failed"
        )

        workflow = store.get_workflow(workflow_id)
        assert workflow is not None
        assert workflow["status"] == "failed"
        snapshots = store.snapshots_after(workflow_id)
        assert snapshots
        assert any(
            node["node_id"] == "analyze" and node["status"] == "failed"
            for node in snapshots[-1]["snapshot"]
        )
        assert store.claim_ready_node("worker-e", lease_seconds=30, workflow_id=workflow_id) is None
        snapshots = store.snapshots_after(workflow_id)
        assert len(snapshots) >= 3
        assert snapshots[-1]["snapshot"]
        assert {node["node_id"]: node["status"] for node in workflow["nodes"]} == {
            "discover": "completed",
            "analyze": "failed",
            "candidate": "pending",
        }
        first_page = store.events_after(workflow_id, limit=2)
        assert len(first_page) == 2
        second_page = store.events_after(workflow_id, last_id=first_page[-1]["id"], limit=2)
        assert len(second_page) == 2
        assert second_page[0]["id"] > first_page[-1]["id"]
        assert len(store.events_after(workflow_id, limit=5000)) <= 1000
        event_types = [event["type"] for event in store.events_after(workflow_id)]
        assert event_types == [
            "workflow_created",
            "node_claimed",
            "node_checkpoint_saved",
            "node_checkpoint_saved",
            "node_claimed",
            "node_completed",
            "node_claimed",
            "node_retry_scheduled",
            "node_claimed",
            "node_failed",
        ]
    finally:
        with psycopg.connect(database_url) as db:
            db.execute(
                "DELETE FROM resource_workflows WHERE workflow_id = %s",
                (workflow_id,),
            )


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_workflow_pause_resume_and_cancel_are_durable_node_boundary_controls() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresWorkflowStore(database_url)
    store.initialize()
    workflow_id = "dag_control_" + uuid.uuid4().hex
    nodes = [
        {"node_id": "first", "node_type": "discover"},
        {"node_id": "second", "node_type": "crawl"},
    ]
    edges = [("first", "second")]

    try:
        assert store.create_workflow(workflow_id, nodes, edges)
        first = store.claim_ready_node("worker-control", lease_seconds=30, workflow_id=workflow_id)
        assert first is not None and first["node_id"] == "first"
        assert store.request_control(workflow_id, "pause")
        assert store.get_workflow(workflow_id)["status"] == "pausing"
        assert store.complete_node(
            workflow_id,
            "first",
            "worker-control",
            first["lease_generation"],
            {"ok": True},
        )
        assert store.get_workflow(workflow_id)["status"] == "paused"
        assert (
            store.claim_ready_node("worker-control-2", lease_seconds=30, workflow_id=workflow_id)
            is None
        )

        assert store.request_control(workflow_id, "resume")
        second = store.claim_ready_node(
            "worker-control-2", lease_seconds=30, workflow_id=workflow_id
        )
        assert second is not None and second["node_id"] == "second"
        assert store.request_control(workflow_id, "cancel")
        assert store.get_workflow(workflow_id)["status"] == "cancelling"
        assert store.complete_node(
            workflow_id,
            "second",
            "worker-control-2",
            second["lease_generation"],
            {"ok": True},
        )
        workflow = store.get_workflow(workflow_id)
        assert workflow is not None
        assert workflow["status"] == "cancelled"
        assert [node["status"] for node in workflow["nodes"]] == [
            "completed",
            "completed",
        ]
        event_types = [event["type"] for event in store.events_after(workflow_id)]
        assert "workflow_paused" in event_types
        assert "workflow_control_requested" in event_types
        assert "workflow_cancelled" in event_types
    finally:
        with psycopg.connect(database_url) as db:
            db.execute(
                "DELETE FROM resource_workflows WHERE workflow_id = %s",
                (workflow_id,),
            )


def test_workflow_worker_uses_unique_lease_identity_per_process() -> None:
    first = WorkflowWorker("postgresql://unused", "dag-worker-1")
    second = WorkflowWorker("postgresql://unused", "dag-worker-1")

    assert first.worker_id.startswith("dag-worker-1:")
    assert second.worker_id.startswith("dag-worker-1:")
    assert first.worker_id != second.worker_id


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_expired_lease_at_max_attempts_fails_workflow_instead_of_stalling() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresWorkflowStore(database_url)
    store.initialize()
    workflow_id = "dag_lease_exhausted_" + uuid.uuid4().hex

    try:
        assert store.create_workflow(
            workflow_id,
            [{"node_id": "crawl", "node_type": "crawl", "max_attempts": 1}],
            [],
        )
        claimed = store.claim_ready_node(
            "worker-crashed", lease_seconds=30, workflow_id=workflow_id
        )
        assert claimed is not None
        with psycopg.connect(database_url) as db:
            db.execute(
                "UPDATE resource_workflow_nodes "
                "SET lease_expires_at = NOW() - INTERVAL '1 second' "
                "WHERE workflow_id = %s AND node_id = 'crawl'",
                (workflow_id,),
            )

        assert (
            store.claim_ready_node("worker-recovery", lease_seconds=30, workflow_id=workflow_id)
            is None
        )
        workflow = store.get_workflow(workflow_id)
        assert workflow is not None
        assert workflow["status"] == "failed"
        assert workflow["nodes"][0]["status"] == "failed"
        assert workflow["nodes"][0]["error"] == ("Worker lease expired after maximum attempts")
        event_types = [event["type"] for event in store.events_after(workflow_id)]
        assert "node_failed" in event_types
        assert "workflow_failed" in event_types
    finally:
        with psycopg.connect(database_url) as db:
            db.execute(
                "DELETE FROM resource_workflows WHERE workflow_id = %s",
                (workflow_id,),
            )


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_workflow_retry_uses_exponential_backoff_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from datetime import UTC, datetime, timedelta

    database_url = os.environ["DATABASE_URL"]
    store = PostgresWorkflowStore(database_url)
    store.initialize()
    workflow_id = "dag_backoff_" + uuid.uuid4().hex
    fixed_now = datetime(2026, 1, 1, tzinfo=UTC)
    monkeypatch.setattr("app.workflow_store._now", lambda: fixed_now)

    try:
        assert store.create_workflow(
            workflow_id,
            [{"node_id": "crawl", "node_type": "crawl", "max_attempts": 3}],
            [],
        )
        first = store.claim_ready_node("worker-backoff-1", workflow_id=workflow_id)
        assert first is not None
        assert (
            store.fail_node(
                workflow_id,
                "crawl",
                "worker-backoff-1",
                first["lease_generation"],
                "temporary failure",
            )
            == "retry_wait"
        )

        with psycopg.connect(database_url) as db:
            first_available_at = db.execute(
                "SELECT available_at FROM resource_workflow_nodes "
                "WHERE workflow_id = %s AND node_id = 'crawl'",
                (workflow_id,),
            ).fetchone()[0]
        assert first_available_at == fixed_now + timedelta(seconds=5)

        fixed_now += timedelta(seconds=5)
        second = store.claim_ready_node("worker-backoff-2", workflow_id=workflow_id)
        assert second is not None
        assert second["attempt_count"] == 2
        assert (
            store.fail_node(
                workflow_id,
                "crawl",
                "worker-backoff-2",
                second["lease_generation"],
                "temporary failure again",
            )
            == "retry_wait"
        )

        with psycopg.connect(database_url) as db:
            second_available_at = db.execute(
                "SELECT available_at FROM resource_workflow_nodes "
                "WHERE workflow_id = %s AND node_id = 'crawl'",
                (workflow_id,),
            ).fetchone()[0]
        assert second_available_at == fixed_now + timedelta(seconds=10)
    finally:
        with psycopg.connect(database_url) as db:
            db.execute(
                "DELETE FROM resource_workflows WHERE workflow_id = %s",
                (workflow_id,),
            )
