from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row


def _now() -> str:
    return datetime.now(UTC).isoformat()


class PostgresJobStore:
    """PostgreSQL-backed durable crawl task, result, and audit-event store."""

    def __init__(self, database_url: str) -> None:
        if not database_url.startswith(("postgres://", "postgresql://")):
            raise ValueError("DATABASE_URL must use PostgreSQL")
        self.database_url = database_url

    @contextmanager
    def _connection(self) -> Iterator[psycopg.Connection]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            yield connection

    def initialize(self) -> None:
        with self._connection() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS crawl_jobs (
                    task_id TEXT PRIMARY KEY,
                    seeds_json JSONB NOT NULL,
                    status TEXT NOT NULL,
                    checkpoint_dir TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    result_json JSONB,
                    error TEXT,
                    lease_owner TEXT,
                    lease_expires_at TIMESTAMPTZ,
                    heartbeat_at TIMESTAMPTZ,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    control_request TEXT
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS crawl_events (
                    id BIGSERIAL PRIMARY KEY,
                    task_id TEXT NOT NULL REFERENCES crawl_jobs(task_id) ON DELETE CASCADE,
                    event_type TEXT NOT NULL,
                    payload_json JSONB NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS crawl_results (
                    task_id TEXT NOT NULL REFERENCES crawl_jobs(task_id) ON DELETE CASCADE,
                    sequence BIGINT NOT NULL,
                    item_json JSONB NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (task_id, sequence)
                )
                """
            )
            db.execute("ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT")
            db.execute(
                "ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ"
            )
            db.execute("ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ")
            db.execute(
                "ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS "
                "attempt_count INTEGER NOT NULL DEFAULT 0"
            )
            db.execute("ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS control_request TEXT")
            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_crawl_events_task_id_id
                ON crawl_events(task_id, id)
                """
            )
            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status_created
                ON crawl_jobs(status, created_at)
                """
            )

    @staticmethod
    def _event(
        db: psycopg.Connection,
        task_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        db.execute(
            """
            INSERT INTO crawl_events (task_id, event_type, payload_json, created_at)
            VALUES (%s, %s, %s::jsonb, %s)
            """,
            (task_id, event_type, json.dumps(payload, ensure_ascii=False), _now()),
        )

    def create(self, task_id: str, seeds: list[str], checkpoint_dir: str) -> bool:
        now = _now()
        with self._connection() as db:
            cursor = db.execute(
                """
                INSERT INTO crawl_jobs
                    (task_id, seeds_json, status, checkpoint_dir, created_at, updated_at)
                VALUES (%s, %s::jsonb, 'queued', %s, %s, %s)
                ON CONFLICT (task_id) DO NOTHING
                """,
                (task_id, json.dumps(seeds), checkpoint_dir, now, now),
            )
            created = cursor.rowcount == 1
            if created:
                self._event(db, task_id, "queued", {"seeds": seeds})
            return created

    def update(self, task_id: str, status: str, **fields: Any) -> None:
        allowed = {"started_at", "finished_at", "result_json", "error"}
        updates = {key: value for key, value in fields.items() if key in allowed}
        updates["status"] = status
        updates["updated_at"] = _now()
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            assignments.append(f"{key} = %s::jsonb" if key == "result_json" else f"{key} = %s")
            values.append(value)
        values.append(task_id)
        with self._connection() as db:
            cursor = db.execute(
                f"UPDATE crawl_jobs SET {', '.join(assignments)} WHERE task_id = %s",
                values,
            )
            if cursor.rowcount == 0:
                raise KeyError(f"Unknown crawl task: {task_id}")
            self._event(
                db,
                task_id,
                status,
                {key: value for key, value in fields.items() if key != "result_json"},
            )

    def add_event(self, task_id: str, event_type: str, payload: dict[str, Any]) -> None:
        with self._connection() as db:
            self._event(db, task_id, event_type, payload)

    def get(self, task_id: str) -> dict[str, Any] | None:
        with self._connection() as db:
            row = db.execute(
                "SELECT * FROM crawl_jobs WHERE task_id = %s",
                (task_id,),
            ).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["seeds"] = item.pop("seeds_json")
        result = item.pop("result_json")
        if result is not None:
            item["result"] = result
        return item

    def add_result(self, task_id: str, item: dict[str, Any]) -> int:
        with self._connection() as db:
            db.execute(
                "SELECT task_id FROM crawl_jobs WHERE task_id = %s FOR UPDATE",
                (task_id,),
            )
            row = db.execute(
                "SELECT COALESCE(MAX(sequence), 0) AS max_sequence "
                "FROM crawl_results WHERE task_id = %s",
                (task_id,),
            ).fetchone()
            sequence = int(row["max_sequence"]) + 1
            db.execute(
                """
                INSERT INTO crawl_results (task_id, sequence, item_json, created_at)
                VALUES (%s, %s, %s::jsonb, %s)
                """,
                (task_id, sequence, json.dumps(item, ensure_ascii=False), _now()),
            )
        return sequence

    def get_results(self, task_id: str) -> list[dict[str, Any]]:
        with self._connection() as db:
            rows = db.execute(
                "SELECT item_json FROM crawl_results WHERE task_id = %s ORDER BY sequence",
                (task_id,),
            ).fetchall()
        return [row["item_json"] for row in rows]

    def events_after(self, task_id: str, last_id: int) -> list[dict[str, Any]]:
        with self._connection() as db:
            rows = db.execute(
                """
                SELECT id, event_type, payload_json, created_at
                FROM crawl_events
                WHERE task_id = %s AND id > %s
                ORDER BY id
                """,
                (task_id, last_id),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "type": row["event_type"],
                "payload": row["payload_json"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def list_queued(self) -> list[dict[str, Any]]:
        with self._connection() as db:
            rows = db.execute(
                "SELECT task_id FROM crawl_jobs WHERE status = 'queued' "
                "ORDER BY created_at, task_id"
            ).fetchall()
        jobs = [self.get(row["task_id"]) for row in rows]
        return [job for job in jobs if job is not None]

    def claim_next(self, worker_id: str, lease_seconds: int = 60) -> dict[str, Any] | None:
        """Atomically claim one queued job or reclaim a job with an expired lease."""
        now = datetime.now(UTC)
        lease_until = datetime.fromtimestamp(now.timestamp() + lease_seconds, UTC)
        with self._connection() as db:
            row = db.execute(
                """
                WITH candidate AS (
                    SELECT task_id
                    FROM crawl_jobs
                    WHERE status = 'queued'
                       OR (status IN ('running', 'pausing') AND (lease_expires_at IS NULL
                           OR lease_expires_at < %s))
                    ORDER BY created_at, task_id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE crawl_jobs AS job
                SET status = 'running',
                    lease_owner = %s,
                    lease_expires_at = %s,
                    heartbeat_at = %s,
                    attempt_count = job.attempt_count + 1,
                    started_at = COALESCE(job.started_at, %s),
                    updated_at = %s
                FROM candidate
                WHERE job.task_id = candidate.task_id
                RETURNING job.task_id
                """,
                (now, worker_id, lease_until, now, now.isoformat(), now.isoformat()),
            ).fetchone()
            if row is None:
                return None
            task_id = row["task_id"]
            self._event(db, task_id, "claimed", {"worker_id": worker_id})
        return self.get(task_id)

    def heartbeat(self, task_id: str, worker_id: str, lease_seconds: int = 60) -> bool:
        now = datetime.now(UTC)
        lease_until = datetime.fromtimestamp(now.timestamp() + lease_seconds, UTC)
        with self._connection() as db:
            cursor = db.execute(
                """
                UPDATE crawl_jobs
                SET heartbeat_at = %s, lease_expires_at = %s, updated_at = %s
                WHERE task_id = %s AND status IN
                    ('running', 'pausing', 'cancelling') AND lease_owner = %s
                    AND lease_expires_at > %s
                """,
                (now, lease_until, now.isoformat(), task_id, worker_id, now),
            )
            return cursor.rowcount == 1

    def release_lease(
        self,
        task_id: str,
        worker_id: str,
        next_status: str = "queued",
    ) -> bool:
        if next_status not in {"queued", "interrupted", "failed", "completed", "paused"}:
            raise ValueError("Unsupported lease release status")
        now = _now()
        with self._connection() as db:
            cursor = db.execute(
                """
                UPDATE crawl_jobs
                SET status = %s, lease_owner = NULL, lease_expires_at = NULL,
                    heartbeat_at = NULL, updated_at = %s
                WHERE task_id = %s AND lease_owner = %s
                """,
                (next_status, now, task_id, worker_id),
            )
            if cursor.rowcount == 1:
                self._event(
                    db,
                    task_id,
                    "lease_released",
                    {"worker_id": worker_id, "status": next_status},
                )
            return cursor.rowcount == 1

    def request_control(self, task_id: str, control: str) -> bool:
        if control not in {"pause", "cancel"}:
            raise ValueError("Unsupported worker control request")
        status = "pausing" if control == "pause" else "cancelling"
        now = _now()
        with self._connection() as db:
            cursor = db.execute(
                """
                UPDATE crawl_jobs
                SET status = %s, control_request = %s, updated_at = %s
                WHERE task_id = %s AND status = 'running' AND lease_owner IS NOT NULL
                """,
                (status, control, now, task_id),
            )
            if cursor.rowcount == 1:
                self._event(db, task_id, f"{control}_requested", {"requested_at": now})
            return cursor.rowcount == 1

    def get_control(self, task_id: str, worker_id: str) -> str | None:
        with self._connection() as db:
            row = db.execute(
                "SELECT control_request FROM crawl_jobs WHERE task_id = %s AND lease_owner = %s",
                (task_id, worker_id),
            ).fetchone()
        return row["control_request"] if row else None

    def resume(self, task_id: str) -> bool:
        now = _now()
        with self._connection() as db:
            cursor = db.execute(
                """
                UPDATE crawl_jobs
                SET status = 'queued', control_request = NULL, finished_at = NULL,
                    error = NULL, updated_at = %s
                WHERE task_id = %s AND status IN ('paused', 'interrupted')
                """,
                (now, task_id),
            )
            if cursor.rowcount == 1:
                self._event(db, task_id, "resumed", {"queued_at": now})
            return cursor.rowcount == 1

    def recover_interrupted(self) -> list[str]:
        with self._connection() as db:
            rows = db.execute(
                "SELECT task_id FROM crawl_jobs "
                "WHERE status IN ('running', 'pausing', 'cancelling') "
                "AND (lease_expires_at IS NULL OR lease_expires_at < %s) FOR UPDATE",
                (datetime.now(UTC),),
            ).fetchall()
            task_ids = [row["task_id"] for row in rows]
            for task_id in task_ids:
                db.execute(
                    "UPDATE crawl_jobs SET status = 'interrupted', updated_at = %s "
                    "WHERE task_id = %s",
                    (_now(), task_id),
                )
                self._event(db, task_id, "interrupted", {"reason": "service_restart"})
        return task_ids
