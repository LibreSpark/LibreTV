from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from app.batch_store import BatchCapacityExceeded, BatchIdempotencyConflict, PostgresBatchStore
from app.candidate_store import PostgresCandidateStore
from app.config import settings, validate_bind_security
from app.job_store import JobStore
from app.postgres_job_store import PostgresJobStore
from app.robots import RobotsPolicyError, RobotsUnavailableError, ensure_robots_allowed
from app.rule_store import PostgresRuleStore
from app.scraper import ScraplingAdapter
from app.security import UnsafeTargetError, validate_public_http_url
from app.spider import ScraplingSpiderAdapter
from app.workflow_store import PostgresWorkflowStore, WorkflowDefinitionError

logging.basicConfig(level=settings.log_level.upper())
logger = logging.getLogger("libretv.scrapling")


validate_bind_security(settings.host, settings.api_key)

app = FastAPI(
    title="LibreTV Scrapling Engine",
    version="0.3.0",
    description=(
        "Phase-two autonomous discovery and isolated crawler service built on upstream Scrapling."
    ),
)
job_store = (
    PostgresJobStore(settings.database_url)
    if settings.database_url
    else JobStore(settings.job_database_path)
)
job_store.initialize()
workflow_store = PostgresWorkflowStore(settings.database_url) if settings.database_url else None
candidate_store = PostgresCandidateStore(settings.database_url) if settings.database_url else None
rule_store = PostgresRuleStore(settings.database_url) if settings.database_url else None
batch_store = (
    PostgresBatchStore(settings.database_url, workflow_store)
    if settings.database_url and workflow_store is not None
    else None
)
if workflow_store is not None:
    workflow_store.initialize()
if candidate_store is not None:
    candidate_store.initialize()
if rule_store is not None:
    rule_store.initialize()
if batch_store is not None:
    batch_store.initialize()
if not settings.database_url:
    job_store.recover_interrupted()
_active_spiders: dict[str, Any] = {}
_legacy_task_ids: set[str] = set()
_job_tasks: dict[str, asyncio.Task] = {}
_job_transition_lock = asyncio.Lock()


class FetchRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    selector: str | None = Field(default=None, max_length=500)
    mode: Literal["text", "css", "xpath", "regex", "adaptive_css", "adaptive_xpath"] = "text"
    adaptive_action: Literal["save", "relocate"] | None = None


class CandidateReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approved", "rejected"]
    note: str = Field(default="", max_length=1000)


class CandidatePlaybackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    media_type: Literal["hls", "mp4", "webm"]
    observed_seconds: int = Field(ge=1, le=60)
    progressed_seconds: float = Field(ge=2, le=60)
    decoded_width: int = Field(ge=1, le=16384)
    decoded_height: int = Field(ge=1, le=16384)
    selected_rendition_height: int = Field(default=0, ge=0, le=16384)
    selected_rendition_bitrate_kbps: float = Field(default=0, ge=0, le=1000000)


class WorkflowControlRequest(BaseModel):
    action: Literal["pause", "resume", "cancel"]


class RuleStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str = Field(default="", max_length=1000)


class WorkflowNodeRequest(BaseModel):
    node_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    node_type: Literal[
        "validate_public_urls",
        "crawl_seed_urls",
        "discover_site_links",
        "autonomous_site_discovery",
        "ai_supervisor_discover",
        "generate_extraction_rule",
        "register_candidates",
        "probe_local_media_file",
        "probe_media_candidates",
        "analyze_media_manifest",
        "analyze_media_candidates",
    ]
    input: dict[str, Any] = Field(default_factory=dict)
    max_attempts: int = Field(default=3, ge=1, le=5)


class BatchRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=1000)
    goal: str = Field(
        default="Discover publicly accessible media references on this site.",
        min_length=1,
        max_length=200,
    )


class AutonomousDiscoveryRequest(BaseModel):
    catalog_urls: list[str] = Field(min_length=1, max_length=5)
    goal: str = Field(
        default="Discover public movie, series and animation resources.",
        min_length=1,
        max_length=1000,
    )
    max_sites: int = Field(default=10, ge=1, le=20)


class WorkflowRequest(BaseModel):
    workflow_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    nodes: list[WorkflowNodeRequest] = Field(min_length=1, max_length=50)
    edges: list[tuple[str, str]] = Field(default_factory=list, max_length=200)
    input: dict[str, Any] = Field(default_factory=dict)


class SpiderRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=20)
    task_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )


def _safe_seed_urls(urls: list[str]) -> list[str]:
    safe_urls: list[str] = []
    try:
        for url in urls:
            safe_url = validate_public_http_url(url)
            if safe_url not in safe_urls:
                safe_urls.append(safe_url)
    except UnsafeTargetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return safe_urls


def _validate_reviewer_sub(value: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > 255 or any(ord(char) < 32 for char in normalized):
        raise HTTPException(
            status_code=400,
            detail="A valid verified reviewer subject is required.",
        )
    return normalized


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _ensure_checkpoint_manifest(
    task_id: str,
    seeds: list[str],
    checkpoint_dir: Path,
) -> None:
    manifest = checkpoint_dir / "libretv-manifest.json"
    if manifest.exists():
        try:
            saved = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=409,
                detail="Checkpoint manifest is unreadable.",
            ) from exc
        if saved.get("task_id") != task_id or saved.get("seeds") != seeds:
            raise HTTPException(
                status_code=409,
                detail="Checkpoint directory belongs to a different task configuration.",
            )
        return
    if checkpoint_dir.exists() and any(checkpoint_dir.iterdir()):
        raise HTTPException(
            status_code=409,
            detail="Checkpoint directory contains unregistered data.",
        )
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    temporary = manifest.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"task_id": task_id, "seeds": seeds}, ensure_ascii=False),
        encoding="utf-8",
    )
    temporary.replace(manifest)


def _schedule_job(task_id: str) -> None:
    # PostgreSQL-backed jobs are claimed only by independent Worker processes.
    if settings.database_url:
        return
    existing = _job_tasks.get(task_id)
    if existing and not existing.done():
        return
    task = asyncio.create_task(_run_job(task_id), name=f"scrapling-job-{task_id}")
    _job_tasks[task_id] = task


async def _run_job(task_id: str) -> None:
    job = job_store.get(task_id)
    if job is None:
        return
    spider = None
    items: list[dict] = job_store.get_results(task_id)
    seen_urls = {item.get("url") for item in items if item.get("url")}
    previous_result = job.get("result") or {}
    stats = previous_result.get("stats", {})
    try:
        spider = ScraplingSpiderAdapter.create(
            job["seeds"],
            Path(job["checkpoint_dir"]),
        )
        _active_spiders[task_id] = spider
        job_store.update(task_id, "running", started_at=job["started_at"] or _now())
        async for item in spider.stream():
            item_url = item.get("url")
            if item_url and item_url in seen_urls:
                continue
            job_store.add_result(task_id, item)
            items.append(item)
            if item_url:
                seen_urls.add(item_url)
            stats = asdict(spider.stats)
            job_store.add_event(
                task_id,
                "item",
                {
                    "count": len(items),
                    "url": item_url,
                    "title": item.get("title"),
                },
            )
        async with _job_transition_lock:
            current = job_store.get(task_id)
            pause_requested = current is not None and current["status"] == "pausing"
            checkpoint_dir = Path(job["checkpoint_dir"])
            has_checkpoint = checkpoint_dir.is_dir() and any(
                path.is_file()
                and path.name != "libretv-manifest.json"
                and not path.name.endswith(".tmp")
                for path in checkpoint_dir.iterdir()
            )
            if pause_requested and has_checkpoint:
                final_status = "paused"
            elif pause_requested and len(items) < len(job["seeds"]):
                final_status = "interrupted"
            else:
                final_status = "completed"
            result = {
                "items": items,
                "completed": final_status == "completed",
                "paused": final_status == "paused",
                "stats": stats,
            }
            job_store.update(
                task_id,
                final_status,
                finished_at=_now() if final_status in {"completed", "failed"} else None,
                error=(
                    "Pause ended without a persisted checkpoint."
                    if final_status == "interrupted"
                    else None
                ),
                result_json=json.dumps(result, ensure_ascii=False),
            )
    except asyncio.CancelledError:
        job_store.update(
            task_id,
            "interrupted",
            error="Task cancelled before a checkpoint was confirmed.",
        )
        raise
    except Exception as exc:
        logger.exception("Scrapling job %s failed", task_id)
        job_store.update(
            task_id,
            "failed",
            finished_at=_now(),
            error=f"{type(exc).__name__}: crawl failed",
        )
    finally:
        _active_spiders.pop(task_id, None)
        current_task = asyncio.current_task()
        if _job_tasks.get(task_id) is current_task:
            _job_tasks.pop(task_id, None)
        latest = job_store.get(task_id)
        if latest is not None and latest["status"] == "queued":
            _schedule_job(task_id)


async def stop_active_crawls() -> None:
    async with _job_transition_lock:
        for task_id, spider_instance in list(_active_spiders.items()):
            job_store.update(task_id, "pausing")
            try:
                spider_instance.pause()
            except RuntimeError:
                job_store.update(
                    task_id,
                    "interrupted",
                    error="Service shutdown occurred before the crawler loop was ready.",
                )
    tasks = list(_job_tasks.values())
    if tasks:
        _, pending = await asyncio.wait(tasks, timeout=30)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Queued jobs were durably accepted before the previous process stopped.
    # Re-schedule them on startup instead of incorrectly marking them interrupted.
    for job in job_store.list_queued():
        _schedule_job(job["task_id"])
    yield
    await stop_active_crawls()


app.router.lifespan_context = lifespan


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    if request.url.path.startswith("/v1/") and settings.api_key is not None:
        supplied = request.headers.get("x-api-key", "")
        expected = settings.api_key.get_secret_value()
        if not secrets.compare_digest(supplied, expected):
            return JSONResponse(
                status_code=401,
                content={"detail": "A valid X-API-Key header is required."},
            )
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "engine": "scrapling", "phase": "2"}


@app.get("/capabilities")
async def capabilities() -> dict:
    return {
        "upstream": "D4Vinci/Scrapling",
        "implemented": [
            "http_fetch",
            "safe_redirect_policy",
            "css_extraction",
            "xpath_extraction",
            "regex_extraction",
            "adaptive_css_extraction",
            "adaptive_xpath_extraction",
            "text_extraction",
            "markdown_conversion",
            "public_target_validation",
            "spider_seed_crawl",
            (
                "bounded_same_origin_recursive_discovery"
                if settings.database_url
                else "recursive_discovery_requires_postgresql_worker"
            ),
            "spider_concurrency_limits",
            "spider_robots_txt_policy",
            "one_off_fetch_robots_policy",
            "spider_checkpoint_storage",
            "persistent_job_registry",
            "async_job_execution",
            "job_status_api",
            "job_event_stream",
            (
                "api_pause_resume_controls"
                if not settings.database_url
                else "independent_worker_execution"
            ),
            "worker_lease_fencing" if settings.database_url else "single_process_execution",
            (
                "persistent_batches_up_to_1000_tasks"
                if settings.database_url
                else "batches_require_postgresql"
            ),
            (
                "batch_full_aggregation_paging_and_retry"
                if settings.database_url
                else "batch_management_requires_postgresql"
            ),
            (
                "checkpointed_workflow_recovery"
                if settings.database_url
                else "workflow_recovery_requires_postgresql"
            ),
            "same_site_rate_limiter_and_circuit_breaker",
            (
                "media_probe_budget_reservations"
                if settings.database_url
                else "media_probe_budget_requires_postgresql"
            ),
            (
                "sample_decode_and_frame_extraction"
                if settings.database_url
                else "sampled_media_decode_requires_postgresql"
            ),
            (
                "cross_process_pause_resume_cancel"
                if settings.database_url
                else "in_process_pause_resume"
            ),
            "server_side_dag_runtime" if settings.database_url else "dag_requires_postgresql",
            (
                "autonomous_public_site_discovery_to_pending_candidates"
                if settings.database_url
                else "autonomous_discovery_requires_postgresql"
            ),
            "workflow_node_leases_and_retries" if settings.database_url else "no_workflow_worker",
            (
                "model_planned_discovery"
                if bool(
                    settings.supervisor_api_key
                    and settings.supervisor_api_key.get_secret_value()
                    and settings.supervisor_model
                )
                else "supervisor_requires_model_configuration"
            ),
            (
                "ai_selector_generation_and_live_test"
                if bool(
                    settings.supervisor_api_key
                    and settings.supervisor_api_key.get_secret_value()
                    and settings.supervisor_model
                )
                else "selector_generation_requires_model_configuration"
            ),
            (
                "candidate_evidence_registry"
                if settings.database_url
                else "candidate_store_requires_postgresql"
            ),
            (
                "authenticated_transactional_candidate_publication"
                if settings.database_url
                else "candidate_publication_requires_postgresql"
            ),
            (
                "reviewer_identity_from_verified_access_or_session"
                if settings.database_url
                else "reviewer_identity_requires_postgresql"
            ),
            (
                "versioned_rule_registry"
                if settings.database_url
                else "rule_registry_requires_postgresql"
            ),
            (
                "hls_dash_manifest_quality_analysis"
                if settings.database_url
                else "media_analysis_requires_postgresql"
            ),
        ],
        "planned": [
            "dynamic_browser_rendering",
            "stealth_browser",
            "automatic_extraction_rule_self_repair",
            "rule_rollback",
            "network_api_capture",
            "unrestricted_cross_origin_discovery",
            "mcp_agent_integration",
        ],
        "service_layer": [
            "target_validation",
            "health_endpoint",
            "structured_fetch_api",
            "durable_job_registry",
            "worker_control_events" if settings.database_url else "local_spider_controls",
            "postgresql_job_store" if settings.database_url else "sqlite_local_job_store",
        ],
        "note": (
            "Only implemented entries have been integrated. "
            "PostgreSQL mode requires at least one independent worker. "
            "Dynamic browser capture and cross-origin discovery remain disabled until "
            "request-level and deployment egress protections are verified. Bounded "
            "same-origin discovery revalidates each URL but still requires network-level "
            "egress filtering to close DNS-rebinding races."
        ),
    }


@app.post("/v1/fetch")
async def fetch(request: FetchRequest) -> dict:
    try:
        target = validate_public_http_url(request.url)
    except UnsafeTargetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if request.mode != "text" and not request.selector:
        raise HTTPException(
            status_code=422,
            detail=f"A selector or pattern is required for {request.mode} extraction.",
        )
    if request.mode.startswith("adaptive_") and request.adaptive_action is None:
        raise HTTPException(
            status_code=422,
            detail="Adaptive extraction requires adaptive_action='save' or 'relocate'.",
        )
    if not request.mode.startswith("adaptive_") and request.adaptive_action is not None:
        raise HTTPException(
            status_code=422,
            detail="adaptive_action is only valid for adaptive extraction modes.",
        )

    try:
        await run_in_threadpool(
            ensure_robots_allowed,
            target,
            settings.request_timeout_seconds,
        )
        page = await run_in_threadpool(
            ScraplingAdapter.fetch_page,
            target,
            settings.request_timeout_seconds,
        )
        result = await run_in_threadpool(
            ScraplingAdapter.extract,
            page,
            request.selector,
            request.mode,
            adaptive_action=request.adaptive_action,
        )
        return {"ok": True, "result": result}
    except RobotsPolicyError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except RobotsUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Scrapling fetch failed for host %s", urlsplit(target).hostname)
        raise HTTPException(
            status_code=502,
            detail="Scrapling could not fetch the target.",
        ) from exc


@app.post("/v1/spider")
async def spider(request: SpiderRequest) -> dict:
    safe_urls = _safe_seed_urls(request.urls)
    if request.task_id:
        async with _job_transition_lock:
            if request.task_id in _legacy_task_ids or job_store.get(request.task_id) is not None:
                raise HTTPException(
                    status_code=409,
                    detail="task_id is already in use; use a new ID or the managed jobs API.",
                )
            _legacy_task_ids.add(request.task_id)

    try:
        checkpoint_dir = None
        if request.task_id:
            checkpoint_dir = Path(settings.crawl_data_dir).expanduser().resolve() / request.task_id
            _ensure_checkpoint_manifest(request.task_id, safe_urls, checkpoint_dir)
        result = await run_in_threadpool(
            ScraplingSpiderAdapter.crawl,
            safe_urls,
            checkpoint_dir,
        )
        return {
            "ok": True,
            "task_id": request.task_id,
            "checkpoint_enabled": checkpoint_dir is not None,
            "result": result,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Scrapling spider failed for %d seed URLs", len(safe_urls))
        raise HTTPException(
            status_code=502,
            detail="Scrapling spider could not complete the crawl.",
        ) from exc
    finally:
        if request.task_id:
            async with _job_transition_lock:
                _legacy_task_ids.discard(request.task_id)


@app.post("/v1/jobs", status_code=202)
async def create_job(request: SpiderRequest) -> dict:
    safe_urls = _safe_seed_urls(request.urls)
    task_id = request.task_id or uuid.uuid4().hex
    checkpoint_dir = Path(settings.crawl_data_dir).expanduser().resolve() / task_id

    async with _job_transition_lock:
        if task_id in _legacy_task_ids:
            raise HTTPException(
                status_code=409,
                detail="task_id is currently running through the legacy Spider API.",
            )
        existing = job_store.get(task_id)
        if existing is not None:
            if existing["seeds"] != safe_urls:
                raise HTTPException(
                    status_code=409,
                    detail="task_id already exists with a different seed configuration.",
                )
            _ensure_checkpoint_manifest(
                task_id,
                existing["seeds"],
                Path(existing["checkpoint_dir"]),
            )
            if existing["status"] == "queued":
                _schedule_job(task_id)
            return {"ok": True, "created": False, "job": job_store.get(task_id)}

        _ensure_checkpoint_manifest(task_id, safe_urls, checkpoint_dir)
        job_store.create(task_id, safe_urls, str(checkpoint_dir))
        _schedule_job(task_id)
        return {"ok": True, "created": True, "job": job_store.get(task_id)}


@app.post("/v1/batches", status_code=202)
async def create_batch(payload: BatchRequest, request: Request) -> dict:
    if batch_store is None:
        raise HTTPException(status_code=501, detail="Durable task batches require PostgreSQL mode.")
    idempotency_key = request.headers.get("idempotency-key", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{16,128}", idempotency_key):
        raise HTTPException(
            status_code=400,
            detail="A 16-128 character Idempotency-Key header is required.",
        )
    safe_urls = await asyncio.to_thread(_safe_seed_urls, payload.urls)
    request_hash = batch_store.request_hash(safe_urls, payload.goal.strip())
    try:
        result = await asyncio.to_thread(
            batch_store.create_batch,
            idempotency_key,
            request_hash,
            safe_urls,
            payload.goal.strip(),
        )
    except BatchIdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except BatchCapacityExceeded as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    batch = await asyncio.to_thread(batch_store.get_batch, result["batch_id"], limit=25, offset=0)
    return {
        "ok": True,
        "created": result["created"],
        "deduplicated_count": len(payload.urls) - len(safe_urls),
        "batch": batch,
        "capacity_note": (
            "Tasks are queued; worker replicas and per-site controls bound execution concurrency."
        ),
    }


@app.get("/v1/batches")
async def list_batches(limit: int = 50) -> dict:
    if batch_store is None:
        raise HTTPException(status_code=501, detail="Durable task batches require PostgreSQL mode.")
    batches = await asyncio.to_thread(batch_store.list_batches, min(max(limit, 1), 50))
    return {"ok": True, "count": len(batches), "batches": batches}


@app.get("/v1/batches/summary")
async def batch_summary() -> dict:
    if batch_store is None:
        raise HTTPException(status_code=501, detail="Durable task batches require PostgreSQL mode.")
    summary = await asyncio.to_thread(batch_store.global_summary)
    return {"ok": True, "summary": summary}


@app.get("/v1/batches/{batch_id}")
async def get_batch(batch_id: str, limit: int = 50, offset: int = 0) -> dict:
    if batch_store is None:
        raise HTTPException(status_code=501, detail="Durable task batches require PostgreSQL mode.")
    if not re.fullmatch(r"[a-f0-9]{32}", batch_id):
        raise HTTPException(status_code=400, detail="Invalid batch ID.")
    batch = await asyncio.to_thread(
        batch_store.get_batch,
        batch_id,
        limit=min(max(limit, 1), 100),
        offset=max(offset, 0),
    )
    if batch is None:
        raise HTTPException(status_code=404, detail="Task batch not found.")
    return {"ok": True, "batch": batch}


@app.post("/v1/batches/{batch_id}/retry")
async def retry_failed_batch_tasks(batch_id: str) -> dict:
    if batch_store is None:
        raise HTTPException(status_code=501, detail="Durable task batches require PostgreSQL mode.")
    if not re.fullmatch(r"[a-f0-9]{32}", batch_id):
        raise HTTPException(status_code=400, detail="Invalid batch ID.")
    result = await asyncio.to_thread(batch_store.retry_failed, batch_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Task batch not found.")
    return {"ok": True, **result}


@app.get("/v1/batches/{batch_id}/events")
async def batch_events(batch_id: str, after: int = 0, limit: int = 200) -> dict:
    if batch_store is None:
        raise HTTPException(status_code=501, detail="Durable task batches require PostgreSQL mode.")
    if not re.fullmatch(r"[a-f0-9]{32}", batch_id):
        raise HTTPException(status_code=400, detail="Invalid batch ID.")
    if await asyncio.to_thread(batch_store.get_batch, batch_id, limit=1, offset=0) is None:
        raise HTTPException(status_code=404, detail="Task batch not found.")
    events = await asyncio.to_thread(
        batch_store.events_after,
        batch_id,
        max(after, 0),
        min(max(limit, 1), 1000),
    )
    return {"ok": True, "events": events, "next_after": events[-1]["id"] if events else after}


@app.post("/v1/autonomous/discover", status_code=202)
async def start_autonomous_discovery(request: AutonomousDiscoveryRequest) -> dict:
    """Start a durable autonomous discovery-to-candidate workflow."""
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Autonomous discovery requires PostgreSQL worker mode.",
        )
    if not (
        settings.supervisor_api_key
        and settings.supervisor_api_key.get_secret_value()
        and settings.supervisor_model
        and settings.egress_proxy_url
    ):
        raise HTTPException(
            status_code=503,
            detail="AI model credentials and the validated egress proxy must be configured.",
        )
    try:
        catalog_urls = _safe_seed_urls(request.catalog_urls)
    except HTTPException:
        raise
    workflow_id = uuid.uuid4().hex
    nodes = [
        {
            "node_id": "discover_sites",
            "node_type": "autonomous_site_discovery",
            "input": {
                "catalog_urls": catalog_urls,
                "goal": request.goal,
                "max_sites": request.max_sites,
            },
            "max_attempts": 2,
        }
    ]
    try:
        created = workflow_store.create_workflow(
            workflow_id,
            nodes,
            [],
            {
                "kind": "autonomous_public_site_discovery",
                "catalog_urls": catalog_urls,
                "goal": request.goal,
                "max_sites": request.max_sites,
            },
        )
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not created:
        raise HTTPException(status_code=409, detail="Workflow ID collision; retry.")
    return {
        "ok": True,
        "workflow_id": workflow_id,
        "status": "running",
        "catalog_count": len(catalog_urls),
        "max_sites": request.max_sites,
        "review_gate": "all resource candidates remain pending human review",
    }


@app.post("/v1/workflows", status_code=202)
async def create_workflow(request: WorkflowRequest) -> dict:
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Durable DAG workflows require PostgreSQL mode.",
        )
    workflow_id = request.workflow_id or uuid.uuid4().hex
    nodes = [node.model_dump() for node in request.nodes]
    try:
        created = workflow_store.create_workflow(
            workflow_id,
            nodes,
            request.edges,
            request.input,
        )
    except WorkflowDefinitionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not created:
        raise HTTPException(status_code=409, detail="Workflow ID already exists.")
    return {
        "ok": True,
        "workflow_id": workflow_id,
        "status": "running",
        "node_count": len(nodes),
    }


@app.get("/v1/rules")
async def list_rules(status: str | None = None, limit: int = 100) -> dict:
    if rule_store is None:
        raise HTTPException(
            status_code=501,
            detail="Persistent extraction rules require PostgreSQL mode.",
        )
    rules = rule_store.list_rules(status=status, limit=limit)
    return {"ok": True, "count": len(rules), "rules": rules}


@app.get("/v1/rules/{rule_id}")
async def get_rule(rule_id: str) -> dict:
    if rule_store is None:
        raise HTTPException(
            status_code=501,
            detail="Persistent extraction rules require PostgreSQL mode.",
        )
    rule = rule_store.get_rule(rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Extraction rule not found.")
    return {"ok": True, "rule": rule}


@app.post("/v1/rules/{rule_id}/activate")
async def activate_rule(
    rule_id: str,
    request: RuleStatusRequest,
    reviewer_sub: str = Header(..., alias="X-LibreTV-Reviewer-Sub"),
) -> dict:
    if rule_store is None:
        raise HTTPException(
            status_code=501,
            detail="Persistent extraction rules require PostgreSQL mode.",
        )
    changed = rule_store.set_status(
        rule_id, "active", _validate_reviewer_sub(reviewer_sub), request.note
    )
    if not changed:
        if rule_store.get_rule(rule_id) is None:
            raise HTTPException(status_code=404, detail="Extraction rule not found.")
        raise HTTPException(status_code=409, detail="Extraction rule could not be activated.")
    return {"ok": True, "rule_id": rule_id, "status": "active"}


@app.post("/v1/rules/{rule_id}/disable")
async def disable_rule(
    rule_id: str,
    request: RuleStatusRequest,
    reviewer_sub: str = Header(..., alias="X-LibreTV-Reviewer-Sub"),
) -> dict:
    if rule_store is None:
        raise HTTPException(
            status_code=501,
            detail="Persistent extraction rules require PostgreSQL mode.",
        )
    changed = rule_store.set_status(
        rule_id, "disabled", _validate_reviewer_sub(reviewer_sub), request.note
    )
    if not changed:
        if rule_store.get_rule(rule_id) is None:
            raise HTTPException(status_code=404, detail="Extraction rule not found.")
        raise HTTPException(status_code=409, detail="Extraction rule could not be disabled.")
    return {"ok": True, "rule_id": rule_id, "status": "disabled"}


@app.get("/v1/candidates")
async def list_candidates(status: str | None = None, limit: int = 50) -> dict:
    if candidate_store is None:
        raise HTTPException(
            status_code=501,
            detail="Resource candidates require PostgreSQL mode.",
        )
    candidates = candidate_store.list_candidates(status=status, limit=limit)
    return {"ok": True, "count": len(candidates), "candidates": candidates}


@app.post("/v1/candidates/{candidate_id}/review")
async def review_candidate(
    candidate_id: str,
    request: CandidateReviewRequest,
    reviewer_sub: str = Header(..., alias="X-LibreTV-Reviewer-Sub"),
) -> dict:
    if candidate_store is None:
        raise HTTPException(status_code=501, detail="Candidate review requires PostgreSQL mode.")
    actor = _validate_reviewer_sub(reviewer_sub)
    try:
        reviewed = await asyncio.to_thread(
            candidate_store.review_candidate,
            candidate_id,
            request.decision,
            actor,
            request.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not reviewed:
        candidate = await asyncio.to_thread(candidate_store.get_candidate, candidate_id)
        if candidate is None:
            raise HTTPException(status_code=404, detail="Resource candidate not found.")
        raise HTTPException(status_code=409, detail="Candidate is no longer awaiting human review.")
    return {
        "ok": True,
        "candidate_id": candidate_id,
        "status": request.decision,
        "formal_resource_published": request.decision == "approved",
        "resource_id": candidate_id if request.decision == "approved" else None,
        "reviewer_sub": actor,
    }


@app.post("/v1/candidates/{candidate_id}/playback")
async def record_candidate_playback(
    candidate_id: str,
    request: CandidatePlaybackRequest,
    reviewer_sub: str = Header(..., alias="X-LibreTV-Reviewer-Sub"),
) -> dict:
    if candidate_store is None:
        raise HTTPException(
            status_code=501,
            detail="Candidate playback verification requires PostgreSQL mode.",
        )
    evidence = {**request.model_dump(), "reviewer_sub": _validate_reviewer_sub(reviewer_sub)}
    try:
        recorded = await asyncio.to_thread(
            candidate_store.record_playback_evidence,
            candidate_id,
            evidence,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not recorded:
        if await asyncio.to_thread(candidate_store.get_candidate, candidate_id) is None:
            raise HTTPException(status_code=404, detail="Resource candidate not found.")
        raise HTTPException(status_code=409, detail="Candidate is no longer awaiting review.")
    return {"ok": True, "candidate_id": candidate_id, "playback_confirmed": True}


@app.get("/v1/registry/resources")
async def list_formal_resources(q: str = "", limit: int = 100) -> dict:
    if candidate_store is None:
        raise HTTPException(status_code=501, detail="Formal resources require PostgreSQL mode.")
    resources = candidate_store.list_formal_resources(q, min(max(limit, 1), 100))
    return {"ok": True, "count": len(resources), "resources": resources}


@app.get("/v1/registry/resources/{resource_id}")
async def get_formal_resource(resource_id: str) -> dict:
    if candidate_store is None:
        raise HTTPException(status_code=501, detail="Formal resources require PostgreSQL mode.")
    resource = candidate_store.get_formal_resource(resource_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Formal resource not found.")
    return {"ok": True, "resource": resource}


@app.post("/v1/registry/resources/{resource_id}/verifications")
async def record_formal_resource_playback(
    resource_id: str,
    request: CandidatePlaybackRequest,
) -> dict:
    if candidate_store is None:
        raise HTTPException(status_code=501, detail="Formal resources require PostgreSQL mode.")
    if not re.fullmatch(r"[a-f0-9]{24}", resource_id):
        raise HTTPException(status_code=400, detail="Invalid resource ID.")
    recorded = await asyncio.to_thread(
        candidate_store.record_formal_resource_playback,
        resource_id,
        request.model_dump(),
    )
    if not recorded:
        raise HTTPException(status_code=404, detail="Formal resource not found.")
    return {"ok": True, "resource_id": resource_id, "playback_verified": True}


@app.get("/v1/registry/search")
async def search_formal_resources(q: str = "", limit: int = 50) -> dict:
    if not q.strip() or len(q) > 100:
        return {"ok": True, "resources": [], "queued": []}
    result = await list_formal_resources(q, min(max(limit, 1), 100))
    return {"ok": True, "resources": result["resources"], "queued": []}


@app.get("/v1/candidates/{candidate_id}")
async def get_candidate(candidate_id: str) -> dict:
    if candidate_store is None:
        raise HTTPException(
            status_code=501,
            detail="Resource candidates require PostgreSQL mode.",
        )
    candidate = candidate_store.get_candidate(candidate_id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="Resource candidate not found.")
    return {"ok": True, "candidate": candidate}


@app.get("/v1/workflows")
async def list_workflows(limit: int = 50) -> dict:
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Durable DAG workflows require PostgreSQL mode.",
        )
    workflows = workflow_store.list_workflows(limit=limit)
    return {"ok": True, "count": len(workflows), "workflows": workflows}


@app.post("/v1/workflows/{workflow_id}/control")
async def control_workflow(
    workflow_id: str,
    request: WorkflowControlRequest,
) -> dict:
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Durable DAG workflow controls require PostgreSQL mode.",
        )
    changed = workflow_store.request_control(workflow_id, request.action)
    if not changed:
        workflow = workflow_store.get_workflow(workflow_id)
        if workflow is None:
            raise HTTPException(status_code=404, detail="Workflow not found.")
        raise HTTPException(
            status_code=409,
            detail=f"Cannot {request.action} workflow in state {workflow['status']}.",
        )
    workflow_store.reconcile_controls()
    return {
        "ok": True,
        "workflow": workflow_store.get_workflow(workflow_id),
    }


@app.get("/v1/workflows/{workflow_id}")
async def get_workflow(workflow_id: str) -> dict:
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Durable DAG workflows require PostgreSQL mode.",
        )
    workflow = workflow_store.get_workflow(workflow_id)
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found.")
    return {"ok": True, "workflow": workflow}


@app.get("/v1/workflows/{workflow_id}/snapshots")
async def workflow_snapshots(
    workflow_id: str,
    after: int = 0,
    limit: int = 100,
) -> dict:
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Durable workflow snapshots require PostgreSQL mode.",
        )
    if await asyncio.to_thread(workflow_store.get_workflow, workflow_id) is None:
        raise HTTPException(status_code=404, detail="Workflow not found.")
    snapshots = await asyncio.to_thread(
        workflow_store.snapshots_after,
        workflow_id,
        max(after, 0),
        min(max(limit, 1), 500),
    )
    return {
        "ok": True,
        "snapshots": snapshots,
        "next_after": snapshots[-1]["id"] if snapshots else after,
    }


@app.get("/v1/workflows/{workflow_id}/events")
async def workflow_events(
    workflow_id: str,
    request: Request,
    last_event_id: int = 0,
) -> StreamingResponse:
    if workflow_store is None:
        raise HTTPException(
            status_code=501,
            detail="Durable DAG workflows require PostgreSQL mode.",
        )
    if workflow_store.get_workflow(workflow_id) is None:
        raise HTTPException(status_code=404, detail="Workflow not found.")

    async def stream_events():
        header_cursor = request.headers.get("last-event-id", "0")
        try:
            cursor = max(last_event_id, int(header_cursor))
        except ValueError:
            cursor = max(last_event_id, 0)
        while True:
            events = workflow_store.events_after(workflow_id, cursor)
            for event in events:
                cursor = event["id"]
                payload = json.dumps(event, ensure_ascii=False)
                yield f"id: {cursor}\nevent: {event['type']}\ndata: {payload}\n\n"
            workflow = workflow_store.get_workflow(workflow_id)
            if workflow is None or workflow["status"] in {"completed", "failed"}:
                break
            if not events:
                yield ": keep-alive\n\n"
                await asyncio.sleep(1)

    return StreamingResponse(stream_events(), media_type="text/event-stream")


@app.get("/v1/jobs/{task_id}")
async def get_job(task_id: str) -> dict:
    job = job_store.get(task_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Crawl job not found.")
    if job["status"] != "completed":
        job["partial_results"] = job_store.get_results(task_id)
    return {"ok": True, "job": job}


@app.post("/v1/jobs/{task_id}/pause")
async def pause_job(task_id: str) -> dict:
    async with _job_transition_lock:
        job = job_store.get(task_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Crawl job not found.")
        if settings.database_url:
            if not job_store.request_control(task_id, "pause"):
                raise HTTPException(
                    status_code=409,
                    detail="Crawl job is not running under an active worker lease.",
                )
            return {"ok": True, "task_id": task_id, "status": "pausing"}
        spider_instance = _active_spiders.get(task_id)
        if job["status"] != "running" or spider_instance is None:
            raise HTTPException(status_code=409, detail="Crawl job is not currently pausable.")
        job_store.update(task_id, "pausing")
        try:
            spider_instance.pause()
        except RuntimeError as exc:
            job_store.update(
                task_id,
                "running",
                error="Pause request rejected before crawl loop started.",
            )
            raise HTTPException(
                status_code=409,
                detail="Spider has not started its crawl loop.",
            ) from exc
        return {"ok": True, "task_id": task_id, "status": "pausing"}


@app.post("/v1/jobs/{task_id}/cancel")
async def cancel_job(task_id: str) -> dict:
    if not settings.database_url:
        raise HTTPException(
            status_code=501,
            detail="Cross-process cancellation requires PostgreSQL worker mode.",
        )
    if job_store.get(task_id) is None:
        raise HTTPException(status_code=404, detail="Crawl job not found.")
    if not job_store.request_control(task_id, "cancel"):
        raise HTTPException(
            status_code=409,
            detail="Crawl job is not running under an active worker lease.",
        )
    return {"ok": True, "task_id": task_id, "status": "cancelling"}


@app.post("/v1/jobs/{task_id}/resume", status_code=202)
async def resume_job(task_id: str) -> dict:
    async with _job_transition_lock:
        job = job_store.get(task_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Crawl job not found.")
        if job["status"] not in {"paused", "interrupted"}:
            raise HTTPException(
                status_code=409,
                detail="Only paused or interrupted jobs can be resumed.",
            )
        checkpoint_dir = Path(job["checkpoint_dir"])
        _ensure_checkpoint_manifest(task_id, job["seeds"], checkpoint_dir)
        checkpoint_files = [
            path
            for path in checkpoint_dir.iterdir()
            if path.is_file()
            and path.name != "libretv-manifest.json"
            and not path.name.endswith(".tmp")
        ]
        if not checkpoint_files:
            raise HTTPException(
                status_code=409,
                detail="No saved Scrapling checkpoint is available for this job.",
            )
        if settings.database_url:
            if not job_store.resume(task_id):
                raise HTTPException(status_code=409, detail="Job state changed; retry resume.")
        else:
            job_store.update(task_id, "queued", finished_at=None, error=None)
            _schedule_job(task_id)
        return {"ok": True, "task_id": task_id, "status": "queued"}


@app.get("/v1/jobs/{task_id}/events")
async def job_events(
    task_id: str,
    request: Request,
    last_event_id: int = 0,
) -> StreamingResponse:
    if job_store.get(task_id) is None:
        raise HTTPException(status_code=404, detail="Crawl job not found.")

    async def stream_events():
        header_cursor = request.headers.get("last-event-id", "0")
        try:
            cursor = max(last_event_id, int(header_cursor))
        except ValueError:
            cursor = max(last_event_id, 0)
        while True:
            events = job_store.events_after(task_id, cursor)
            for event in events:
                cursor = event["id"]
                payload = json.dumps(event, ensure_ascii=False)
                yield f"id: {cursor}\nevent: {event['type']}\ndata: {payload}\n\n"
            job = job_store.get(task_id)
            if job is None or job["status"] in {
                "completed",
                "paused",
                "failed",
                "interrupted",
                "cancelled",
            }:
                break
            if not events:
                yield ": keep-alive\n\n"
                await asyncio.sleep(1)

    return StreamingResponse(stream_events(), media_type="text/event-stream")
