from __future__ import annotations

import argparse
import asyncio
import json
import logging
import socket
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from app.config import settings
from app.postgres_job_store import PostgresJobStore
from app.security import validate_public_http_url
from app.spider import ScraplingSpiderAdapter

logger = logging.getLogger("libretv.scrapling.worker")


class LeaseLost(RuntimeError):
    """Raised when this worker no longer owns a task lease."""


class CrawlWorker:
    """Independent PostgreSQL-polling worker with lease heartbeats and fenced writes."""

    def __init__(
        self,
        database_url: str,
        worker_id: str,
        lease_seconds: int = 60,
        poll_seconds: float = 2.0,
    ) -> None:
        if lease_seconds < 15:
            raise ValueError("lease_seconds must be at least 15")
        if poll_seconds <= 0:
            raise ValueError("poll_seconds must be positive")
        self.database_url = database_url
        # A stable Compose service name is not a safe lease owner across restarts.
        self.worker_id = f"{worker_id}:{uuid.uuid4().hex}"
        self.lease_seconds = lease_seconds
        self.poll_seconds = poll_seconds
        self.store = PostgresJobStore(database_url)

    def _fenced_result(self, task_id: str, item: dict[str, Any]) -> bool:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            row = db.execute(
                "SELECT status FROM crawl_jobs WHERE task_id = %s "
                "AND lease_owner = %s AND lease_expires_at > NOW() FOR UPDATE",
                (task_id, self.worker_id),
            ).fetchone()
            if row is None:
                raise LeaseLost(task_id)
            if row["status"] != "running":
                return False
            sequence = db.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM crawl_results "
                "WHERE task_id = %s",
                (task_id,),
            ).fetchone()["next"]
            db.execute(
                "INSERT INTO crawl_results (task_id, sequence, item_json, created_at) "
                "VALUES (%s, %s, %s::jsonb, %s)",
                (task_id, sequence, json.dumps(item, ensure_ascii=False), _now()),
            )
            db.execute(
                "INSERT INTO crawl_events (task_id, event_type, payload_json, created_at) "
                "VALUES (%s, 'item', %s::jsonb, %s)",
                (
                    task_id,
                    json.dumps(
                        {"count": sequence, "url": item.get("url"), "title": item.get("title")}
                    ),
                    _now(),
                ),
            )
            return True

    def _fenced_finish(
        self,
        task_id: str,
        status: str,
        result: dict[str, Any],
        error: str | None = None,
    ) -> None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            cursor = db.execute(
                "UPDATE crawl_jobs SET status = %s, result_json = %s::jsonb, error = %s, "
                "finished_at = %s, updated_at = %s, lease_owner = NULL, "
                "lease_expires_at = NULL, heartbeat_at = NULL "
                "WHERE task_id = %s AND status IN "
                "('running', 'pausing', 'cancelling') AND lease_owner = %s "
                "AND lease_expires_at > NOW()",
                (
                    status,
                    json.dumps(result, ensure_ascii=False),
                    error,
                    _now() if status in {"completed", "failed", "cancelled"} else None,
                    _now(),
                    task_id,
                    self.worker_id,
                ),
            )
            if cursor.rowcount != 1:
                raise LeaseLost(task_id)
            db.execute(
                "INSERT INTO crawl_events (task_id, event_type, payload_json, created_at) "
                "VALUES (%s, %s, %s::jsonb, %s)",
                (
                    task_id,
                    status,
                    json.dumps({"worker_id": self.worker_id, "error": error}),
                    _now(),
                ),
            )

    async def _heartbeat(self, task_id: str, stop: asyncio.Event, lost: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.lease_seconds / 3)
                return
            except TimeoutError:
                owned = await asyncio.to_thread(
                    self.store.heartbeat, task_id, self.worker_id, self.lease_seconds
                )
                if not owned:
                    lost.set()
                    return

    async def _watch_control(
        self,
        task_id: str,
        spider: Any,
        stop: asyncio.Event,
        requested: asyncio.Event,
        control: dict[str, str | None],
    ) -> None:
        while not stop.is_set():
            command = await asyncio.to_thread(self.store.get_control, task_id, self.worker_id)
            if command in {"pause", "cancel"}:
                control["command"] = command
                requested.set()
                try:
                    spider.pause()
                except RuntimeError:
                    logger.info("Control request arrived before Spider started for %s", task_id)
                return
            try:
                await asyncio.wait_for(stop.wait(), timeout=1.0)
            except TimeoutError:
                continue

    async def process_once(self) -> bool:
        job = await asyncio.to_thread(self.store.claim_next, self.worker_id, self.lease_seconds)
        if job is None:
            return False

        task_id = job["task_id"]
        stop = asyncio.Event()
        lost = asyncio.Event()
        heartbeat = asyncio.create_task(self._heartbeat(task_id, stop, lost))
        control_requested = asyncio.Event()
        control: dict[str, str | None] = {"command": None}
        items = await asyncio.to_thread(self.store.get_results, task_id)
        seen = {item.get("url") for item in items if item.get("url")}
        stats: dict[str, Any] = {}
        try:
            safe_seeds = [validate_public_http_url(url) for url in job["seeds"]]
            spider = ScraplingSpiderAdapter.create(safe_seeds, Path(job["checkpoint_dir"]))
            watcher = asyncio.create_task(
                self._watch_control(task_id, spider, stop, control_requested, control)
            )
            async for item in spider.stream():
                if lost.is_set():
                    raise LeaseLost(task_id)
                if control_requested.is_set():
                    break
                item_url = item.get("url")
                if item_url and item_url in seen:
                    continue
                persisted = await asyncio.to_thread(self._fenced_result, task_id, item)
                if not persisted:
                    control["command"] = await asyncio.to_thread(
                        self.store.get_control, task_id, self.worker_id
                    )
                    control_requested.set()
                    break
                items.append(item)
                if item_url:
                    seen.add(item_url)
                stats = asdict(spider.stats)

            if lost.is_set():
                raise LeaseLost(task_id)
            command = control["command"]
            final_status = (
                "paused"
                if command == "pause"
                else "cancelled"
                if command == "cancel"
                else "completed"
            )
            self._fenced_finish(
                task_id,
                final_status,
                {
                    "items": items,
                    "completed": final_status == "completed",
                    "paused": final_status == "paused",
                    "cancelled": final_status == "cancelled",
                    "stats": stats,
                },
            )
        except LeaseLost:
            logger.warning("Worker %s lost lease for task %s", self.worker_id, task_id)
        except Exception as exc:
            logger.exception("Worker %s failed task %s", self.worker_id, task_id)
            try:
                self._fenced_finish(
                    task_id,
                    "failed",
                    {"items": items, "completed": False, "paused": False, "stats": stats},
                    f"{type(exc).__name__}: crawl failed",
                )
            except LeaseLost:
                logger.warning("Lease expired before failure could be recorded for %s", task_id)
        finally:
            stop.set()
            await heartbeat
            if "watcher" in locals():
                await watcher
        return True

    async def run_forever(self) -> None:
        self.store.initialize()
        logger.info("Worker %s started", self.worker_id)
        while True:
            processed = await self.process_once()
            if not processed:
                await asyncio.sleep(self.poll_seconds)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def main() -> None:
    parser = argparse.ArgumentParser(description="LibreTV Scrapling PostgreSQL worker")
    parser.add_argument("--worker-id", default=f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}")
    parser.add_argument("--lease-seconds", type=int, default=60)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    args = parser.parse_args()
    if not settings.database_url:
        parser.error("DATABASE_URL is required for the independent worker")
    logging.basicConfig(level=settings.log_level.upper())
    worker = CrawlWorker(
        settings.database_url,
        args.worker_id,
        lease_seconds=args.lease_seconds,
        poll_seconds=args.poll_seconds,
    )
    asyncio.run(worker.run_forever())


if __name__ == "__main__":
    main()
