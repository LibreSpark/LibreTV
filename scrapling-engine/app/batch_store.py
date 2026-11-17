from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import psycopg
from psycopg.rows import dict_row

from app.config import settings
from app.workflow_store import PostgresWorkflowStore

MAX_ACTIVE_BATCH_TASKS = 20_000
MAX_MEDIA_PROBE_BYTES_PER_CANDIDATE = 64 * 1024 * 1024
MAX_AI_RULE_SITES_PER_BATCH = 10


class BatchCapacityExceeded(ValueError):
    pass


class BatchIdempotencyConflict(ValueError):
    pass


class PostgresBatchStore:
    def __init__(
        self,
        database_url: str,
        workflows: PostgresWorkflowStore | None = None,
    ) -> None:
        if not database_url.startswith(("postgres://", "postgresql://")):
            raise ValueError("DATABASE_URL must use PostgreSQL")
        self.database_url = database_url
        self.workflows = workflows or PostgresWorkflowStore(database_url)

    def initialize(self) -> None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_task_batches (
                    batch_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    request_hash TEXT NOT NULL,
                    goal TEXT NOT NULL,
                    total_count INTEGER NOT NULL,
                    media_probe_budget_bytes BIGINT NOT NULL DEFAULT 1073741824,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_task_batch_items (
                    batch_id TEXT NOT NULL REFERENCES resource_task_batches(batch_id)
                        ON DELETE CASCADE,
                    task_index INTEGER NOT NULL,
                    workflow_id TEXT NOT NULL UNIQUE REFERENCES resource_workflows(workflow_id)
                        ON DELETE CASCADE,
                    target_url TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (batch_id, task_index)
                )
                """
            )
            db.execute(
                "ALTER TABLE resource_task_batches ADD COLUMN IF NOT EXISTS "
                "media_probe_budget_bytes BIGINT NOT NULL DEFAULT 1073741824"
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_task_batch_media_reservations (
                    batch_id TEXT NOT NULL REFERENCES resource_task_batches(batch_id)
                        ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL,
                    bytes_reserved BIGINT NOT NULL CHECK (bytes_reserved >= 0),
                    created_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (batch_id, candidate_id)
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_task_batch_events (
                    id BIGSERIAL PRIMARY KEY,
                    batch_id TEXT NOT NULL REFERENCES resource_task_batches(batch_id)
                        ON DELETE CASCADE,
                    workflow_id TEXT,
                    task_index INTEGER,
                    event_type TEXT NOT NULL,
                    payload_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_resource_batch_events_cursor "
                "ON resource_task_batch_events(batch_id, id)"
            )
            db.execute(
                """
                CREATE OR REPLACE FUNCTION capture_resource_batch_event()
                RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE current_batch_id TEXT;
                DECLARE current_task_index INTEGER;
                BEGIN
                    SELECT batch_id, task_index INTO current_batch_id, current_task_index
                    FROM resource_task_batch_items
                    WHERE workflow_id = NEW.workflow_id;
                    IF current_batch_id IS NOT NULL THEN
                        INSERT INTO resource_task_batch_events
                            (batch_id, workflow_id, task_index, event_type, payload_json,
                             created_at)
                        VALUES
                            (current_batch_id, NEW.workflow_id, current_task_index,
                             NEW.event_type, NEW.payload_json, NEW.created_at);
                        UPDATE resource_task_batches
                        SET updated_at = NEW.created_at
                        WHERE batch_id = current_batch_id;
                    END IF;
                    RETURN NEW;
                END;
                $$
                """
            )
            db.execute(
                "DROP TRIGGER IF EXISTS trg_resource_batch_event ON resource_workflow_events"
            )
            db.execute(
                """
                CREATE TRIGGER trg_resource_batch_event
                AFTER INSERT ON resource_workflow_events
                FOR EACH ROW EXECUTE FUNCTION capture_resource_batch_event()
                """
            )

    @staticmethod
    def _task_graph() -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
        nodes = [
            {
                "node_id": "validate",
                "node_type": "validate_public_urls",
                "input": {"urls": []},
                "max_attempts": 1,
            },
            {
                "node_id": "discover",
                "node_type": "discover_site_links",
                "input": {"max_pages": 20, "max_depth": 2, "max_links_per_page": 20},
                "max_attempts": 3,
            },
            {
                "node_id": "rule",
                "node_type": "generate_extraction_rule",
                "input": {"goal": "", "enabled": False},
                "max_attempts": 1,
            },
            {
                "node_id": "register",
                "node_type": "register_candidates",
                "input": {},
                "max_attempts": 3,
            },
            {
                "node_id": "analyze",
                "node_type": "analyze_media_candidates",
                "input": {},
                "max_attempts": 3,
            },
            {
                "node_id": "probe",
                "node_type": "probe_media_candidates",
                "input": {
                    "max_file_candidates": 1,
                    "max_download_bytes": 64 * 1024 * 1024,
                    "timeout_seconds": 15,
                },
                "max_attempts": 3,
            },
        ]
        edges = [
            ("validate", "discover"),
            ("discover", "rule"),
            ("discover", "register"),
            ("register", "analyze"),
            ("register", "probe"),
        ]
        return nodes, edges

    def create_batch(
        self,
        idempotency_key: str,
        request_hash: str,
        urls: list[str],
        goal: str,
    ) -> dict[str, Any]:
        if not 1 <= len(urls) <= 1000:
            raise ValueError("A batch must contain between 1 and 1000 unique tasks.")
        if not idempotency_key or len(idempotency_key) > 128:
            raise ValueError("A valid idempotency key is required.")
        now = datetime.now(UTC)
        batch_id = uuid.uuid4().hex
        nodes, edges = self._task_graph()
        self.workflows._validate_graph(nodes, edges)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            inserted = db.execute(
                """
                INSERT INTO resource_task_batches
                    (batch_id, idempotency_key, request_hash, goal, total_count,
                     created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING batch_id
                """,
                (batch_id, idempotency_key, request_hash, goal, len(urls), now, now),
            ).fetchone()
            if inserted is None:
                existing = db.execute(
                    "SELECT batch_id, request_hash FROM resource_task_batches "
                    "WHERE idempotency_key = %s",
                    (idempotency_key,),
                ).fetchone()
                if existing is None:
                    raise RuntimeError("Idempotent batch lookup failed.")
                if existing["request_hash"] != request_hash:
                    raise BatchIdempotencyConflict(
                        "This idempotency key was already used for a different task list."
                    )
                return {"batch_id": existing["batch_id"], "created": False}

            db.execute("SELECT pg_advisory_xact_lock(774921003)")
            active_count = db.execute(
                """
                SELECT COUNT(*) AS count
                FROM resource_task_batch_items AS item
                JOIN resource_workflows AS workflow USING (workflow_id)
                WHERE workflow.status NOT IN ('completed', 'failed', 'cancelled')
                """
            ).fetchone()["count"]
            if int(active_count) + len(urls) > MAX_ACTIVE_BATCH_TASKS:
                raise BatchCapacityExceeded(
                    f"Active task capacity ({MAX_ACTIVE_BATCH_TASKS}) would be exceeded."
                )

            supervisor_key = (
                settings.supervisor_api_key.get_secret_value()
                if settings.supervisor_api_key is not None
                else ""
            )
            supervisor_configured = bool(supervisor_key and settings.supervisor_model)
            rule_origins: set[str] = set()
            for index, target_url in enumerate(urls):
                workflow_id = uuid.uuid4().hex
                parsed = urlsplit(target_url)
                origin = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"
                generate_rule = (
                    supervisor_configured
                    and origin not in rule_origins
                    and len(rule_origins) < MAX_AI_RULE_SITES_PER_BATCH
                )
                if generate_rule:
                    rule_origins.add(origin)
                workflow_input = {
                    "kind": "intelligent_collection_task",
                    "batch_id": batch_id,
                    "task_index": index,
                    "target_url": target_url,
                    "site_host": (parsed.hostname or "").lower(),
                    "generate_rule": generate_rule,
                    "goal": goal,
                }
                db.execute(
                    """
                    INSERT INTO resource_workflows
                        (workflow_id, status, input_json, created_at, updated_at)
                    VALUES (%s, 'running', %s::jsonb, %s, %s)
                    """,
                    (workflow_id, json.dumps(workflow_input, ensure_ascii=False), now, now),
                )
                db.execute(
                    """
                    INSERT INTO resource_task_batch_items
                        (batch_id, task_index, workflow_id, target_url, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (batch_id, index, workflow_id, target_url, now),
                )
                for node in nodes:
                    node_input = dict(node.get("input", {}))
                    if node["node_id"] == "validate":
                        node_input["urls"] = [target_url]
                    if node["node_id"] == "rule":
                        node_input["goal"] = goal
                        node_input["enabled"] = generate_rule
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
                            json.dumps(node_input, ensure_ascii=False),
                            node["max_attempts"],
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
                self.workflows._event(
                    db,
                    workflow_id,
                    None,
                    "workflow_created",
                    {"nodes": [node["node_id"] for node in nodes], "edges": edges},
                )
            db.execute(
                """
                INSERT INTO resource_task_batch_events
                    (batch_id, event_type, payload_json, created_at)
                VALUES (%s, 'batch_created', %s::jsonb, %s)
                """,
                (
                    batch_id,
                    json.dumps({"total_count": len(urls), "goal": goal}, ensure_ascii=False),
                    now,
                ),
            )
        return {"batch_id": batch_id, "created": True}

    def _batch_summary(self, db: psycopg.Connection, batch_id: str) -> dict[str, Any] | None:
        batch = db.execute(
            "SELECT * FROM resource_task_batches WHERE batch_id = %s", (batch_id,)
        ).fetchone()
        if batch is None:
            return None
        counts = db.execute(
            """
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE workflow.status = 'completed') AS succeeded,
                COUNT(*) FILTER (WHERE workflow.status = 'failed') AS failed,
                COUNT(*) FILTER (WHERE workflow.status = 'cancelled') AS cancelled,
                COUNT(*) FILTER (WHERE workflow.status = 'paused') AS paused,
                COUNT(*) FILTER (
                    WHERE workflow.status IN ('running', 'pausing', 'cancelling')
                      AND EXISTS (
                          SELECT 1 FROM resource_workflow_nodes AS node
                          WHERE node.workflow_id = workflow.workflow_id
                            AND node.status = 'running'
                      )
                ) AS running,
                COUNT(*) FILTER (
                    WHERE workflow.status = 'running'
                      AND NOT EXISTS (
                          SELECT 1 FROM resource_workflow_nodes AS node
                          WHERE node.workflow_id = workflow.workflow_id
                            AND node.status = 'running'
                      )
                ) AS queued,
                COALESCE(SUM(retries.retry_count), 0) AS retries
            FROM resource_task_batch_items AS item
            JOIN resource_workflows AS workflow USING (workflow_id)
            LEFT JOIN (
                SELECT workflow_id, SUM(GREATEST(attempt_count - 1, 0)) AS retry_count
                FROM resource_workflow_nodes GROUP BY workflow_id
            ) AS retries USING (workflow_id)
            WHERE item.batch_id = %s
            """,
            (batch_id,),
        ).fetchone()
        candidates = db.execute(
            """
            SELECT COUNT(DISTINCT candidate.candidate_id) AS count
            FROM resource_candidates AS candidate
            JOIN resource_task_batch_items AS item
              ON item.workflow_id = candidate.discovery_workflow_id
            WHERE item.batch_id = %s
            """,
            (batch_id,),
        ).fetchone()["count"]
        media_probe_bytes = db.execute(
            "SELECT COALESCE(SUM(bytes_reserved), 0) AS total "
            "FROM resource_task_batch_media_reservations WHERE batch_id = %s",
            (batch_id,),
        ).fetchone()["total"]
        return {
            "batch_id": batch["batch_id"],
            "goal": batch["goal"],
            "total": int(counts["total"]),
            "succeeded": int(counts["succeeded"]),
            "failed": int(counts["failed"]),
            "cancelled": int(counts["cancelled"]),
            "active": int(counts["running"] + counts["queued"]),
            "running": int(counts["running"]),
            "queued": int(counts["queued"]),
            "paused": int(counts["paused"]),
            "retries": int(counts["retries"]),
            "candidate_count": int(candidates or 0),
            "media_probe_bytes": int(media_probe_bytes or 0),
            "media_probe_budget_bytes": int(batch["media_probe_budget_bytes"]),
            "created_at": batch["created_at"],
            "updated_at": batch["updated_at"],
        }

    def get_batch(
        self,
        batch_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any] | None:
        safe_limit = min(max(int(limit), 1), 100)
        safe_offset = max(int(offset), 0)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            summary = self._batch_summary(db, batch_id)
            if summary is None:
                return None
            rows = db.execute(
                """
                SELECT item.task_index, item.workflow_id, item.target_url,
                       workflow.status, workflow.created_at, workflow.updated_at,
                       COUNT(node.node_id) FILTER (
                           WHERE node.status = 'completed'
                       ) AS completed_nodes,
                       COUNT(node.node_id) AS total_nodes,
                       MAX(node.attempt_count) AS attempts
                FROM resource_task_batch_items AS item
                JOIN resource_workflows AS workflow USING (workflow_id)
                LEFT JOIN resource_workflow_nodes AS node USING (workflow_id)
                WHERE item.batch_id = %s
                GROUP BY item.task_index, item.workflow_id, item.target_url,
                         workflow.status, workflow.created_at, workflow.updated_at
                ORDER BY item.task_index
                LIMIT %s OFFSET %s
                """,
                (batch_id, safe_limit, safe_offset),
            ).fetchall()
            summary["tasks"] = [dict(row) for row in rows]
            summary["limit"] = safe_limit
            summary["offset"] = safe_offset
            return summary

    def list_batches(self, limit: int = 20) -> list[dict[str, Any]]:
        safe_limit = min(max(int(limit), 1), 50)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                "SELECT batch_id FROM resource_task_batches ORDER BY created_at DESC LIMIT %s",
                (safe_limit,),
            ).fetchall()
            return [
                summary
                for row in rows
                if (summary := self._batch_summary(db, row["batch_id"])) is not None
            ]

    def global_summary(self) -> dict[str, int]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            counts = db.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(DISTINCT item.batch_id) AS batch_count,
                    COUNT(*) FILTER (WHERE workflow.status = 'completed') AS succeeded,
                    COUNT(*) FILTER (WHERE workflow.status = 'failed') AS failed,
                    COUNT(*) FILTER (WHERE workflow.status = 'cancelled') AS cancelled,
                    COUNT(*) FILTER (WHERE workflow.status = 'paused') AS paused,
                    COUNT(*) FILTER (
                        WHERE workflow.status IN ('running', 'pausing', 'cancelling')
                          AND EXISTS (
                              SELECT 1 FROM resource_workflow_nodes AS node
                              WHERE node.workflow_id = workflow.workflow_id
                                AND node.status = 'running'
                          )
                    ) AS running,
                    COUNT(*) FILTER (
                        WHERE workflow.status = 'running'
                          AND NOT EXISTS (
                              SELECT 1 FROM resource_workflow_nodes AS node
                              WHERE node.workflow_id = workflow.workflow_id
                                AND node.status = 'running'
                          )
                    ) AS queued,
                    COALESCE(SUM(retries.retry_count), 0) AS retries
                FROM resource_task_batch_items AS item
                JOIN resource_workflows AS workflow USING (workflow_id)
                LEFT JOIN (
                    SELECT workflow_id, SUM(GREATEST(attempt_count - 1, 0)) AS retry_count
                    FROM resource_workflow_nodes GROUP BY workflow_id
                ) AS retries USING (workflow_id)
                """
            ).fetchone()
            candidate_count = db.execute(
                """
                SELECT COUNT(DISTINCT candidate.candidate_id) AS count
                FROM resource_candidates AS candidate
                JOIN resource_task_batch_items AS item
                  ON item.workflow_id = candidate.discovery_workflow_id
                """
            ).fetchone()["count"]
            media_probe_bytes = db.execute(
                "SELECT COALESCE(SUM(bytes_reserved), 0) AS total "
                "FROM resource_task_batch_media_reservations"
            ).fetchone()["total"]
            media_probe_budget_bytes = db.execute(
                "SELECT COALESCE(SUM(media_probe_budget_bytes), 0) AS total "
                "FROM resource_task_batches"
            ).fetchone()["total"]
        return {
            "total": int(counts["total"]),
            "succeeded": int(counts["succeeded"]),
            "failed": int(counts["failed"]),
            "cancelled": int(counts["cancelled"]),
            "paused": int(counts["paused"]),
            "running": int(counts["running"]),
            "queued": int(counts["queued"]),
            "active": int(counts["running"] + counts["queued"]),
            "retries": int(counts["retries"]),
            "candidate_count": int(candidate_count or 0),
            "media_probe_bytes": int(media_probe_bytes or 0),
            "media_probe_budget_bytes": int(media_probe_budget_bytes or 0),
            "batch_count": int(counts["batch_count"]),
        }

    def retry_failed(self, batch_id: str) -> dict[str, int] | None:
        now = datetime.now(UTC)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            batch = db.execute(
                "SELECT batch_id FROM resource_task_batches WHERE batch_id = %s FOR UPDATE",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return None
            rows = db.execute(
                """
                SELECT workflow.workflow_id
                FROM resource_task_batch_items AS item
                JOIN resource_workflows AS workflow USING (workflow_id)
                WHERE item.batch_id = %s AND workflow.status = 'failed'
                ORDER BY item.task_index
                FOR UPDATE OF workflow
                """,
                (batch_id,),
            ).fetchall()
            requeued = 0
            for row in rows:
                workflow_id = row["workflow_id"]
                changed = db.execute(
                    """
                    UPDATE resource_workflow_nodes
                    SET status = 'retry_wait', error = NULL, available_at = %s,
                        max_attempts = LEAST(max_attempts + 3, 60), updated_at = %s
                    WHERE workflow_id = %s AND status = 'failed'
                    """,
                    (now, now, workflow_id),
                ).rowcount
                if not changed:
                    continue
                db.execute(
                    "UPDATE resource_workflows SET status = 'running', updated_at = %s "
                    "WHERE workflow_id = %s AND status = 'failed'",
                    (now, workflow_id),
                )
                self.workflows._event(
                    db,
                    workflow_id,
                    None,
                    "workflow_manual_retry_requested",
                    {"additional_attempts": 3},
                )
                self.workflows._store_snapshot(db, workflow_id, now)
                requeued += 1
        return {"requeued": requeued}

    def reserve_media_probe_bytes(
        self,
        batch_id: str,
        candidate_id: str,
        byte_count: int,
    ) -> bool:
        if not 1 <= byte_count <= MAX_MEDIA_PROBE_BYTES_PER_CANDIDATE:
            raise ValueError("A media probe reservation must be between 1 byte and 64 MiB.")
        now = datetime.now(UTC)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            batch = db.execute(
                "SELECT media_probe_budget_bytes FROM resource_task_batches "
                "WHERE batch_id = %s FOR UPDATE",
                (batch_id,),
            ).fetchone()
            if batch is None:
                return False
            existing = db.execute(
                "SELECT bytes_reserved FROM resource_task_batch_media_reservations "
                "WHERE batch_id = %s AND candidate_id = %s",
                (batch_id, candidate_id),
            ).fetchone()
            if existing is not None:
                return int(existing["bytes_reserved"]) == byte_count
            used = db.execute(
                "SELECT COALESCE(SUM(bytes_reserved), 0) AS total "
                "FROM resource_task_batch_media_reservations WHERE batch_id = %s",
                (batch_id,),
            ).fetchone()["total"]
            if int(used) + byte_count > int(batch["media_probe_budget_bytes"]):
                db.execute(
                    """
                    INSERT INTO resource_task_batch_events
                        (batch_id, event_type, payload_json, created_at)
                    VALUES (%s, 'media_probe_budget_exhausted', %s::jsonb, %s)
                    """,
                    (
                        batch_id,
                        json.dumps(
                            {
                                "candidate_id": candidate_id,
                                "used_bytes": int(used),
                                "requested_bytes": byte_count,
                                "budget_bytes": int(batch["media_probe_budget_bytes"]),
                            }
                        ),
                        now,
                    ),
                )
                return False
            db.execute(
                """
                INSERT INTO resource_task_batch_media_reservations
                    (batch_id, candidate_id, bytes_reserved, created_at)
                VALUES (%s, %s, %s, %s)
                """,
                (batch_id, candidate_id, byte_count, now),
            )
            db.execute(
                """
                INSERT INTO resource_task_batch_events
                    (batch_id, event_type, payload_json, created_at)
                VALUES (%s, 'media_probe_budget_reserved', %s::jsonb, %s)
                """,
                (
                    batch_id,
                    json.dumps({"candidate_id": candidate_id, "bytes": byte_count}),
                    now,
                ),
            )
            db.execute(
                "UPDATE resource_task_batches SET updated_at = %s WHERE batch_id = %s",
                (now, batch_id),
            )
            return True

    def adjust_media_probe_reservation(
        self,
        batch_id: str,
        reservation_id: str,
        actual_bytes: int,
    ) -> bool:
        if actual_bytes < 0:
            return False
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            db.execute(
                "SELECT batch_id FROM resource_task_batches WHERE batch_id = %s FOR UPDATE",
                (batch_id,),
            )
            existing = db.execute(
                "SELECT bytes_reserved FROM resource_task_batch_media_reservations "
                "WHERE batch_id = %s AND candidate_id = %s FOR UPDATE",
                (batch_id, reservation_id),
            ).fetchone()
            if existing is None or actual_bytes > int(existing["bytes_reserved"]):
                return False
            db.execute(
                "UPDATE resource_task_batch_media_reservations "
                "SET bytes_reserved = %s WHERE batch_id = %s AND candidate_id = %s",
                (actual_bytes, batch_id, reservation_id),
            )
            return True

    def events_after(
        self,
        batch_id: str,
        last_id: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        safe_limit = min(max(int(limit), 1), 1000)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                """
                SELECT id, workflow_id, task_index, event_type, payload_json, created_at
                FROM resource_task_batch_events
                WHERE batch_id = %s AND id > %s
                ORDER BY id
                LIMIT %s
                """,
                (batch_id, max(int(last_id), 0), safe_limit),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "workflow_id": row["workflow_id"],
                "task_index": row["task_index"],
                "type": row["event_type"],
                "payload": row["payload_json"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    @staticmethod
    def request_hash(urls: list[str], goal: str) -> str:
        payload = json.dumps(
            {"urls": urls, "goal": goal},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()
