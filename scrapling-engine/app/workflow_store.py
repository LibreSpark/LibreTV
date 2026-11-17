from __future__ import annotations

import json
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from psycopg.rows import dict_row


def _now() -> datetime:
    return datetime.now(UTC)


class WorkflowDefinitionError(ValueError):
    """Raised when a workflow graph is invalid."""


class PostgresWorkflowStore:
    """Durable server-side DAG definitions, node leases, retries, and audit events."""

    def __init__(self, database_url: str) -> None:
        if not database_url.startswith(("postgres://", "postgresql://")):
            raise ValueError("DATABASE_URL must use PostgreSQL")
        self.database_url = database_url

    def initialize(self) -> None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_workflows (
                    workflow_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    input_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_workflow_nodes (
                    workflow_id TEXT NOT NULL REFERENCES resource_workflows(workflow_id)
                        ON DELETE CASCADE,
                    node_id TEXT NOT NULL,
                    node_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    input_json JSONB NOT NULL,
                    result_json JSONB,
                    error TEXT,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 3,
                    available_at TIMESTAMPTZ NOT NULL,
                    lease_owner TEXT,
                    lease_expires_at TIMESTAMPTZ,
                    lease_generation BIGINT NOT NULL DEFAULT 0,
                    checkpoint_json JSONB,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (workflow_id, node_id)
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_workflow_edges (
                    workflow_id TEXT NOT NULL,
                    parent_node_id TEXT NOT NULL,
                    child_node_id TEXT NOT NULL,
                    PRIMARY KEY (workflow_id, parent_node_id, child_node_id),
                    FOREIGN KEY (workflow_id, parent_node_id)
                        REFERENCES resource_workflow_nodes(workflow_id, node_id)
                        ON DELETE CASCADE,
                    FOREIGN KEY (workflow_id, child_node_id)
                        REFERENCES resource_workflow_nodes(workflow_id, node_id)
                        ON DELETE CASCADE,
                    CHECK (parent_node_id <> child_node_id)
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_workflow_events (
                    id BIGSERIAL PRIMARY KEY,
                    workflow_id TEXT NOT NULL REFERENCES resource_workflows(workflow_id)
                        ON DELETE CASCADE,
                    node_id TEXT,
                    event_type TEXT NOT NULL,
                    payload_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_workflow_nodes_ready
                ON resource_workflow_nodes(status, available_at, created_at)
                """
            )
            db.execute(
                "ALTER TABLE resource_workflow_nodes "
                "ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0"
            )
            db.execute(
                "ALTER TABLE resource_workflow_nodes ADD COLUMN IF NOT EXISTS checkpoint_json JSONB"
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_workflow_snapshots (
                    snapshot_id BIGSERIAL PRIMARY KEY,
                    workflow_id TEXT NOT NULL REFERENCES resource_workflows(workflow_id)
                        ON DELETE CASCADE,
                    snapshot_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_snapshots_cursor "
                "ON resource_workflow_snapshots(workflow_id, snapshot_id)"
            )

            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_workflow_events_cursor
                ON resource_workflow_events(workflow_id, id)
                """
            )

    @staticmethod
    def _validate_graph(nodes: list[dict[str, Any]], edges: list[tuple[str, str]]) -> None:
        ids = [str(node.get("node_id", "")) for node in nodes]
        if not ids or any(not node_id for node_id in ids) or len(set(ids)) != len(ids):
            raise WorkflowDefinitionError("Workflow requires unique non-empty node IDs.")
        known = set(ids)
        if len(set(edges)) != len(edges):
            raise WorkflowDefinitionError("Workflow edges must be unique.")
        indegree = dict.fromkeys(known, 0)
        children: dict[str, list[str]] = defaultdict(list)
        for parent, child in edges:
            if parent not in known or child not in known or parent == child:
                raise WorkflowDefinitionError("Workflow edge references an invalid node.")
            children[parent].append(child)
            indegree[child] += 1
        ready = deque(node_id for node_id, degree in indegree.items() if degree == 0)
        visited = 0
        while ready:
            current = ready.popleft()
            visited += 1
            for child in children[current]:
                indegree[child] -= 1
                if indegree[child] == 0:
                    ready.append(child)
        if visited != len(known):
            raise WorkflowDefinitionError("Workflow graph must be acyclic.")

    @staticmethod
    def _event(
        db: psycopg.Connection,
        workflow_id: str,
        node_id: str | None,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        db.execute(
            """
            INSERT INTO resource_workflow_events
                (workflow_id, node_id, event_type, payload_json, created_at)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            """,
            (
                workflow_id,
                node_id,
                event_type,
                json.dumps(payload, ensure_ascii=False),
                _now(),
            ),
        )

    @staticmethod
    def _store_snapshot(
        db: psycopg.Connection,
        workflow_id: str,
        created_at: datetime,
    ) -> None:
        rows = db.execute(
            """
            SELECT node_id, status, attempt_count, lease_generation,
                   result_json, checkpoint_json, error
            FROM resource_workflow_nodes
            WHERE workflow_id = %s
            ORDER BY node_id
            """,
            (workflow_id,),
        ).fetchall()
        snapshot = [dict(row) for row in rows]
        db.execute(
            """
            INSERT INTO resource_workflow_snapshots
                (workflow_id, snapshot_json, created_at)
            VALUES (%s, %s::jsonb, %s)
            """,
            (workflow_id, json.dumps(snapshot, ensure_ascii=False, default=str), created_at),
        )

    def create_workflow(
        self,
        workflow_id: str,
        nodes: list[dict[str, Any]],
        edges: list[tuple[str, str]],
        input_data: dict[str, Any] | None = None,
    ) -> bool:
        self._validate_graph(nodes, edges)
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            cursor = db.execute(
                """
                INSERT INTO resource_workflows
                    (workflow_id, status, input_json, created_at, updated_at)
                VALUES (%s, 'running', %s::jsonb, %s, %s)
                ON CONFLICT (workflow_id) DO NOTHING
                """,
                (
                    workflow_id,
                    json.dumps(input_data or {}, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            if cursor.rowcount != 1:
                return False
            for node in nodes:
                db.execute(
                    """
                    INSERT INTO resource_workflow_nodes
                        (workflow_id, node_id, node_type, status, input_json,
                         max_attempts, available_at, created_at, updated_at)
                    VALUES (%s, %s, %s, 'pending', %s::jsonb, %s, %s, %s, %s)
                    """,
                    (
                        workflow_id,
                        node["node_id"],
                        node["node_type"],
                        json.dumps(node.get("input", {}), ensure_ascii=False),
                        max(1, int(node.get("max_attempts", 3))),
                        now,
                        now,
                        now,
                    ),
                )
            for parent, child in edges:
                db.execute(
                    """
                    INSERT INTO resource_workflow_edges
                        (workflow_id, parent_node_id, child_node_id)
                    VALUES (%s, %s, %s)
                    """,
                    (workflow_id, parent, child),
                )
            self._event(
                db,
                workflow_id,
                None,
                "workflow_created",
                {"nodes": [node["node_id"] for node in nodes], "edges": edges},
            )
            return True

    def claim_ready_node(
        self,
        worker_id: str,
        lease_seconds: int = 60,
        workflow_id: str | None = None,
    ) -> dict[str, Any] | None:
        now = _now()
        lease_until = now + timedelta(seconds=lease_seconds)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            # A worker that crashes on its final attempt must not leave a DAG
            # permanently running with an expired, unclaimable lease.
            exhausted = db.execute(
                """
                UPDATE resource_workflow_nodes AS node
                SET status = 'failed',
                    error = 'Worker lease expired after maximum attempts',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = %s
                FROM resource_workflows AS workflow
                WHERE workflow.workflow_id = node.workflow_id
                  AND workflow.status = 'running'
                  AND node.status = 'running'
                  AND node.lease_expires_at < %s
                  AND node.attempt_count >= node.max_attempts
                  AND (%s::text IS NULL OR node.workflow_id = %s::text)
                RETURNING node.workflow_id, node.node_id, node.attempt_count
                """,
                (now, now, workflow_id, workflow_id),
            ).fetchall()
            failed_workflows: set[str] = set()
            for expired in exhausted:
                failed_workflows.add(expired["workflow_id"])
                self._event(
                    db,
                    expired["workflow_id"],
                    expired["node_id"],
                    "node_failed",
                    {
                        "attempt": expired["attempt_count"],
                        "error": "Worker lease expired after maximum attempts",
                    },
                )
            for failed_workflow_id in failed_workflows:
                cursor = db.execute(
                    """
                    UPDATE resource_workflows
                    SET status = 'failed', updated_at = %s
                    WHERE workflow_id = %s AND status = 'running'
                    """,
                    (now, failed_workflow_id),
                )
                if cursor.rowcount:
                    self._event(
                        db,
                        failed_workflow_id,
                        None,
                        "workflow_failed",
                        {"reason": "node_lease_exhausted"},
                    )
            row = db.execute(
                """
                WITH candidate AS (
                    SELECT node.workflow_id, node.node_id
                    FROM resource_workflow_nodes AS node
                    JOIN resource_workflows AS workflow
                      ON workflow.workflow_id = node.workflow_id
                     AND workflow.status = 'running'
                    WHERE ((
                        node.status IN ('pending', 'retry_wait')
                        AND node.available_at <= %s
                    ) OR (
                        node.status = 'running'
                        AND node.lease_expires_at < %s
                    ))
                    AND (%s::text IS NULL OR node.workflow_id = %s::text)
                    AND NOT EXISTS (
                        SELECT 1
                        FROM resource_workflow_edges AS edge
                        JOIN resource_workflow_nodes AS parent
                          ON parent.workflow_id = edge.workflow_id
                         AND parent.node_id = edge.parent_node_id
                        WHERE edge.workflow_id = node.workflow_id
                          AND edge.child_node_id = node.node_id
                          AND parent.status <> 'completed'
                    )
                    ORDER BY node.created_at, node.workflow_id, node.node_id
                    LIMIT 1
                    FOR UPDATE OF node SKIP LOCKED
                )
                UPDATE resource_workflow_nodes AS node
                SET status = 'running',
                    lease_owner = %s,
                    lease_expires_at = %s,
                    lease_generation = node.lease_generation + 1,
                    attempt_count = node.attempt_count + 1,
                    updated_at = %s
                FROM candidate
                WHERE node.workflow_id = candidate.workflow_id
                  AND node.node_id = candidate.node_id
                RETURNING node.*
                """,
                (now, now, workflow_id, workflow_id, worker_id, lease_until, now),
            ).fetchone()
            if row is None:
                return None
            self._event(
                db,
                row["workflow_id"],
                row["node_id"],
                "node_claimed",
                {
                    "worker_id": worker_id,
                    "attempt": row["attempt_count"],
                    "lease_generation": row["lease_generation"],
                },
            )
            result = dict(row)
            result["input"] = result.pop("input_json")
            result["checkpoint"] = result.pop("checkpoint_json")
            workflow_input = db.execute(
                "SELECT input_json FROM resource_workflows WHERE workflow_id = %s",
                (result["workflow_id"],),
            ).fetchone()
            result["workflow_input"] = workflow_input["input_json"] if workflow_input else {}
            parents = db.execute(
                """
                SELECT edge.parent_node_id, parent.result_json
                FROM resource_workflow_edges AS edge
                JOIN resource_workflow_nodes AS parent
                  ON parent.workflow_id = edge.workflow_id
                 AND parent.node_id = edge.parent_node_id
                WHERE edge.workflow_id = %s AND edge.child_node_id = %s
                ORDER BY edge.parent_node_id
                """,
                (result["workflow_id"], result["node_id"]),
            ).fetchall()
            result["dependencies"] = {
                parent["parent_node_id"]: parent["result_json"] for parent in parents
            }
            return result

    def heartbeat_node(
        self,
        workflow_id: str,
        node_id: str,
        worker_id: str,
        fencing_token: int,
        lease_seconds: int = 60,
    ) -> bool:
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            cursor = db.execute(
                """
                UPDATE resource_workflow_nodes
                SET lease_expires_at = %s, updated_at = %s
                WHERE workflow_id = %s AND node_id = %s
                  AND status = 'running' AND lease_owner = %s
                  AND lease_generation = %s AND lease_expires_at > %s
                """,
                (
                    now + timedelta(seconds=lease_seconds),
                    now,
                    workflow_id,
                    node_id,
                    worker_id,
                    fencing_token,
                    now,
                ),
            )
            return cursor.rowcount == 1

    def save_node_checkpoint(
        self,
        workflow_id: str,
        node_id: str,
        worker_id: str,
        fencing_token: int,
        checkpoint: dict[str, Any],
    ) -> bool:
        serialized = json.dumps(checkpoint, ensure_ascii=False, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > 1_000_000:
            raise ValueError("Workflow node checkpoint exceeds the 1 MiB limit.")
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            cursor = db.execute(
                """
                UPDATE resource_workflow_nodes
                SET checkpoint_json = %s::jsonb, updated_at = %s
                WHERE workflow_id = %s AND node_id = %s
                  AND status = 'running' AND lease_owner = %s
                  AND lease_generation = %s AND lease_expires_at > %s
                """,
                (serialized, now, workflow_id, node_id, worker_id, fencing_token, now),
            )
            if cursor.rowcount != 1:
                return False
            self._event(
                db,
                workflow_id,
                node_id,
                "node_checkpoint_saved",
                {"keys": sorted(checkpoint)},
            )
            self._store_snapshot(db, workflow_id, now)
            return True

    def complete_node(
        self,
        workflow_id: str,
        node_id: str,
        worker_id: str,
        fencing_token: int,
        result: dict[str, Any],
    ) -> bool:
        serialized = json.dumps(result, ensure_ascii=False)
        if len(serialized.encode("utf-8")) > 2_000_000:
            raise ValueError("Workflow node result exceeds the 2 MiB limit.")
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            cursor = db.execute(
                """
                UPDATE resource_workflow_nodes
                SET status = 'completed', result_json = %s::jsonb, error = NULL,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = %s
                WHERE workflow_id = %s AND node_id = %s
                  AND status = 'running' AND lease_owner = %s
                  AND lease_generation = %s AND lease_expires_at > %s
                """,
                (serialized, now, workflow_id, node_id, worker_id, fencing_token, now),
            )
            if cursor.rowcount != 1:
                return False
            self._event(
                db,
                workflow_id,
                node_id,
                "node_completed",
                {"result_keys": sorted(result), "count": result.get("count")},
            )
            self._finish_control_if_idle(db, workflow_id, now)
            workflow_status = db.execute(
                "SELECT status FROM resource_workflows WHERE workflow_id = %s",
                (workflow_id,),
            ).fetchone()["status"]
            remaining = db.execute(
                """
                SELECT COUNT(*) AS count FROM resource_workflow_nodes
                WHERE workflow_id = %s AND status <> 'completed'
                """,
                (workflow_id,),
            ).fetchone()["count"]
            if remaining == 0 and workflow_status == "running":
                db.execute(
                    "UPDATE resource_workflows SET status = 'completed', updated_at = %s "
                    "WHERE workflow_id = %s",
                    (now, workflow_id),
                )
                self._event(db, workflow_id, None, "workflow_completed", {})
            self._store_snapshot(db, workflow_id, now)
            return True

    def fail_node(
        self,
        workflow_id: str,
        node_id: str,
        worker_id: str,
        fencing_token: int,
        error: str,
        retry_delay_seconds: int | None = None,
    ) -> str | None:
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            row = db.execute(
                """
                SELECT attempt_count, max_attempts FROM resource_workflow_nodes
                WHERE workflow_id = %s AND node_id = %s
                  AND status = 'running' AND lease_owner = %s
                  AND lease_generation = %s AND lease_expires_at > %s
                FOR UPDATE
                """,
                (workflow_id, node_id, worker_id, fencing_token, now),
            ).fetchone()
            if row is None:
                return None
            retry = row["attempt_count"] < row["max_attempts"]
            status = "retry_wait" if retry else "failed"
            backoff = (
                min(600, 5 * (2 ** max(0, row["attempt_count"] - 1)))
                if retry_delay_seconds is None
                else max(0, retry_delay_seconds)
            )
            available_at = now + timedelta(seconds=backoff)
            db.execute(
                """
                UPDATE resource_workflow_nodes
                SET status = %s, error = %s, available_at = %s,
                    lease_owner = NULL, lease_expires_at = NULL, updated_at = %s
                WHERE workflow_id = %s AND node_id = %s AND lease_generation = %s
                """,
                (status, error[:500], available_at, now, workflow_id, node_id, fencing_token),
            )
            self._event(
                db,
                workflow_id,
                node_id,
                "node_retry_scheduled" if retry else "node_failed",
                {"attempt": row["attempt_count"], "error": error[:500]},
            )
            if not retry:
                db.execute(
                    "UPDATE resource_workflows SET status = 'failed', updated_at = %s "
                    "WHERE workflow_id = %s AND status = 'running'",
                    (now, workflow_id),
                )
            self._finish_control_if_idle(db, workflow_id, now)
            self._store_snapshot(db, workflow_id, now)
            return status

    def _finish_control_if_idle(
        self,
        db: psycopg.Connection,
        workflow_id: str,
        now: datetime,
    ) -> None:
        workflow = db.execute(
            "SELECT status FROM resource_workflows WHERE workflow_id = %s FOR UPDATE",
            (workflow_id,),
        ).fetchone()
        if workflow is None or workflow["status"] not in {"pausing", "cancelling"}:
            return
        target = workflow["status"]
        expired_status = "pending" if target == "pausing" else "cancelled"
        db.execute(
            """
            UPDATE resource_workflow_nodes
            SET status = %s, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = %s
            WHERE workflow_id = %s AND status = 'running'
              AND (lease_expires_at IS NULL OR lease_expires_at <= %s)
            """,
            (expired_status, now, workflow_id, now),
        )
        active = db.execute(
            """
            SELECT COUNT(*) AS count FROM resource_workflow_nodes
            WHERE workflow_id = %s AND status = 'running'
              AND lease_expires_at > %s
            """,
            (workflow_id, now),
        ).fetchone()["count"]
        if active:
            return
        final_status = "paused" if target == "pausing" else "cancelled"
        if final_status == "cancelled":
            db.execute(
                """
                UPDATE resource_workflow_nodes
                SET status = 'cancelled', updated_at = %s
                WHERE workflow_id = %s AND status IN ('pending', 'retry_wait')
                """,
                (now, workflow_id),
            )
        db.execute(
            "UPDATE resource_workflows SET status = %s, updated_at = %s WHERE workflow_id = %s",
            (final_status, now, workflow_id),
        )
        self._event(db, workflow_id, None, f"workflow_{final_status}", {})

    def request_control(self, workflow_id: str, action: str) -> bool:
        if action not in {"pause", "resume", "cancel"}:
            raise ValueError("Workflow action must be pause, resume or cancel")
        transitions = {
            "pause": ("running", "pausing"),
            "resume": ("paused", "running"),
            "cancel": (("running", "pausing", "paused"), "cancelling"),
        }
        expected, target = transitions[action]
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            row = db.execute(
                "SELECT status FROM resource_workflows WHERE workflow_id = %s FOR UPDATE",
                (workflow_id,),
            ).fetchone()
            if row is None:
                return False
            allowed = expected if isinstance(expected, tuple) else (expected,)
            if row["status"] not in allowed:
                return False
            db.execute(
                "UPDATE resource_workflows SET status = %s, updated_at = %s WHERE workflow_id = %s",
                (target, now, workflow_id),
            )
            self._event(
                db,
                workflow_id,
                None,
                "workflow_control_requested",
                {"action": action},
            )
            self._finish_control_if_idle(db, workflow_id, now)
            return True

    def reconcile_controls(self) -> int:
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                """
                SELECT workflow_id FROM resource_workflows
                WHERE status IN ('pausing', 'cancelling')
                ORDER BY updated_at
                LIMIT 200
                """
            ).fetchall()
            for row in rows:
                self._finish_control_if_idle(db, row["workflow_id"], now)
        return len(rows)

    def list_workflows(self, limit: int = 50) -> list[dict[str, Any]]:
        safe_limit = min(max(limit, 1), 200)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                """
                SELECT workflow.workflow_id, workflow.status,
                       workflow.created_at, workflow.updated_at,
                       COUNT(node.node_id) AS node_count,
                       COUNT(node.node_id) FILTER (
                           WHERE node.status = 'completed'
                       ) AS completed_count,
                       COUNT(node.node_id) FILTER (
                           WHERE node.status = 'failed'
                       ) AS failed_count
                FROM resource_workflows AS workflow
                LEFT JOIN resource_workflow_nodes AS node
                  ON node.workflow_id = workflow.workflow_id
                GROUP BY workflow.workflow_id
                ORDER BY workflow.created_at DESC
                LIMIT %s
                """,
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            workflow = db.execute(
                "SELECT * FROM resource_workflows WHERE workflow_id = %s",
                (workflow_id,),
            ).fetchone()
            if workflow is None:
                return None
            nodes = db.execute(
                "SELECT * FROM resource_workflow_nodes WHERE workflow_id = %s "
                "ORDER BY created_at, node_id",
                (workflow_id,),
            ).fetchall()
            edges = db.execute(
                "SELECT parent_node_id, child_node_id FROM resource_workflow_edges "
                "WHERE workflow_id = %s ORDER BY parent_node_id, child_node_id",
                (workflow_id,),
            ).fetchall()
        result = dict(workflow)
        result["input"] = result.pop("input_json")
        result["nodes"] = [
            {**dict(node), "input": node["input_json"], "result": node["result_json"]}
            for node in nodes
        ]
        result["edges"] = [(edge["parent_node_id"], edge["child_node_id"]) for edge in edges]
        return result

    def snapshots_after(
        self,
        workflow_id: str,
        last_id: int = 0,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        safe_limit = min(max(int(limit), 1), 500)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                """
                SELECT snapshot_id, snapshot_json, created_at
                FROM resource_workflow_snapshots
                WHERE workflow_id = %s AND snapshot_id > %s
                ORDER BY snapshot_id LIMIT %s
                """,
                (workflow_id, max(int(last_id), 0), safe_limit),
            ).fetchall()
        return [
            {
                "id": row["snapshot_id"],
                "snapshot": row["snapshot_json"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def events_after(
        self,
        workflow_id: str,
        last_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        # SSE clients page through the durable event log using the last event ID.
        # Bound each database read so a long-running workflow cannot allocate an
        # unbounded result set in the API process.
        safe_limit = min(max(int(limit), 1), 1000)
        safe_last_id = max(int(last_id), 0)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                """
                SELECT id, node_id, event_type, payload_json, created_at
                FROM resource_workflow_events
                WHERE workflow_id = %s AND id > %s ORDER BY id
                LIMIT %s
                """,
                (workflow_id, safe_last_id, safe_limit),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "node_id": row["node_id"],
                "type": row["event_type"],
                "payload": row["payload_json"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
