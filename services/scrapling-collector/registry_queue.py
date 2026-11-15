from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Header, HTTPException, Query

DB_PATH = Path(os.environ.get("SCRAPLING_DB_PATH", "/data/collector.sqlite3"))
TOKEN = os.environ.get("SCRAPLING_API_TOKEN", "").strip()
router = APIRouter()
TERMINAL = {"succeeded", "partial", "failed", "cancelled"}
ACCESS_BLOCKED = {"AUTH_REQUIRED", "SUBSCRIPTION_REQUIRED", "CHALLENGE", "DRM_PROTECTED", "ENCRYPTED_STREAM"}


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def initialize() -> None:
    with connect() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS registry_movies (
          id TEXT PRIMARY KEY, external_key TEXT UNIQUE, title TEXT NOT NULL,
          year INTEGER, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registry_episodes (
          id TEXT PRIMARY KEY, movie_id TEXT NOT NULL REFERENCES registry_movies(id),
          external_key TEXT UNIQUE, season INTEGER, episode INTEGER, title TEXT NOT NULL DEFAULT '',
          metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registry_sources (
          id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          host TEXT NOT NULL, directory TEXT NOT NULL DEFAULT 'FMHY', metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registry_resources (
          id TEXT PRIMARY KEY, resource_key TEXT NOT NULL UNIQUE,
          movie_id TEXT REFERENCES registry_movies(id), episode_id TEXT REFERENCES registry_episodes(id),
          source_id TEXT REFERENCES registry_sources(id), candidate_id TEXT,
          resource_type TEXT NOT NULL CHECK(resource_type IN ('CMS_VOD','DIRECT_MEDIA','EMBEDDED_PLAYER')),
          url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', access_state TEXT NOT NULL DEFAULT 'ACCESS_UNKNOWN',
          validation_state TEXT NOT NULL DEFAULT 'unverified', playback_state TEXT NOT NULL DEFAULT 'unverified',
          media_format TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_registry_resources_movie ON registry_resources(movie_id);
        CREATE INDEX IF NOT EXISTS idx_registry_resources_episode ON registry_resources(episode_id);
        CREATE INDEX IF NOT EXISTS idx_registry_resources_verified ON registry_resources(validation_state,playback_state);
        CREATE TABLE IF NOT EXISTS registry_verifications (
          id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES registry_resources(id),
          verification_type TEXT NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_registry_verifications_resource ON registry_verifications(resource_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS registry_history (
          id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES registry_resources(id),
          action TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_registry_history_resource ON registry_history(resource_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS collector_jobs (
          id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, job_type TEXT NOT NULL,
          payload TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 4, available_at INTEGER NOT NULL,
          lease_owner TEXT, lease_until INTEGER, checkpoint TEXT NOT NULL DEFAULT '{}',
          result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          cancelled_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_collector_jobs_claim ON collector_jobs(status,available_at,lease_until);
        CREATE TABLE IF NOT EXISTS collector_job_events (
          id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES collector_jobs(id),
          event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
        );
        """)
        now = int(time.time())
        expired = c.execute("SELECT id FROM collector_jobs WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?", (now,)).fetchall()
        c.execute("UPDATE collector_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?", (now, now))
        for row in expired:
            event(c, row["id"], "lease_expired_recovered", {"recovered_at_startup": True})
        cancelled = c.execute("SELECT id FROM collector_jobs WHERE status='cancel_requested' AND lease_until IS NOT NULL AND lease_until<=?", (now,)).fetchall()
        c.execute("UPDATE collector_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='cancel_requested' AND lease_until IS NOT NULL AND lease_until<=?", (now, now))
        for row in cancelled:
            event(c, row["id"], "cancelled_after_worker_lease_expired", {})
        retired = c.execute(
            "SELECT id,job_type FROM collector_jobs WHERE job_type IN ('seedhub_sync','seedhub_detail_sync') AND status NOT IN ('succeeded','partial','failed','cancelled')"
        ).fetchall()
        c.execute(
            """UPDATE collector_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,
               cancelled_at=COALESCE(cancelled_at,?),updated_at=?
               WHERE job_type IN ('seedhub_sync','seedhub_detail_sync')
               AND status NOT IN ('succeeded','partial','failed','cancelled')""",
            (now, now),
        )
        for row in retired:
            event(c, row["id"], "seedhub_collection_retired", {"job_type": row["job_type"]})


def require_auth(authorization: str | None) -> None:
    import hmac
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not TOKEN or not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def event(c: sqlite3.Connection, job_id: str, name: str, detail: dict | None = None) -> None:
    c.execute("INSERT INTO collector_job_events(id,job_id,event,detail,created_at) VALUES(?,?,?,?,?)",
              (uuid.uuid4().hex, job_id, name, json.dumps(detail or {}, ensure_ascii=False), int(time.time())))


def submit_job(job_type: str, payload: dict, idempotency_key: str, max_attempts: int = 4) -> dict:
    if job_type not in {"crawl", "discover"}:
        raise ValueError("Unsupported job type")
    if not idempotency_key or len(idempotency_key) > 200:
        raise ValueError("Invalid idempotency key")
    now = int(time.time())
    job_id = hashlib.sha256(idempotency_key.encode()).hexdigest()[:32]
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute("""INSERT OR IGNORE INTO collector_jobs
          (id,idempotency_key,job_type,payload,status,max_attempts,available_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)""",
          (job_id,idempotency_key,job_type,json.dumps(payload,ensure_ascii=False),"queued",max(1,min(max_attempts,8)),now,now,now))
        row = c.execute("SELECT * FROM collector_jobs WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if c.execute("SELECT changes()").fetchone()[0]:
            event(c, row["id"], "queued", {"job_type": job_type})
        c.commit()
    return dict(row)


def claim_job(worker_id: str, lease_seconds: int = 90) -> dict | None:
    now = int(time.time())
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        expired = c.execute("SELECT id FROM collector_jobs WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?", (now,)).fetchall()
        c.execute("""UPDATE collector_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?""", (now,now))
        for item in expired:
            event(c, item["id"], "lease_expired_recovered", {"recovered_by_worker": worker_id})
        cancelled = c.execute("SELECT id FROM collector_jobs WHERE status='cancel_requested' AND lease_until IS NOT NULL AND lease_until<=?", (now,)).fetchall()
        c.execute("""UPDATE collector_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE status='cancel_requested' AND lease_until IS NOT NULL AND lease_until<=?""", (now,now))
        for item in cancelled:
            event(c, item["id"], "cancelled_after_worker_lease_expired", {})
        row = c.execute("""SELECT * FROM collector_jobs WHERE status='queued' AND available_at<=?
          ORDER BY available_at,created_at LIMIT 1""", (now,)).fetchone()
        if not row:
            c.commit()
            return None
        until = now + max(10, min(lease_seconds, 900))
        c.execute("""UPDATE collector_jobs SET status='running',attempt=attempt+1,lease_owner=?,lease_until=?,updated_at=?
          WHERE id=? AND status='queued'""", (worker_id,until,now,row["id"]))
        claimed = c.execute("SELECT * FROM collector_jobs WHERE id=?", (row["id"],)).fetchone()
        event(c, row["id"], "claimed", {"worker_id": worker_id, "attempt": claimed["attempt"], "lease_until": until})
        c.commit()
        return dict(claimed)


def checkpoint_job(job_id: str, worker_id: str, checkpoint: dict) -> bool:
    with connect() as c:
        now = int(time.time())
        cur = c.execute("""UPDATE collector_jobs SET checkpoint=?,updated_at=?,lease_until=?
          WHERE id=? AND status='running' AND lease_owner=?""",
          (json.dumps(checkpoint,ensure_ascii=False),now,now+900,job_id,worker_id))
        if cur.rowcount:
            event(c,job_id,"checkpoint",checkpoint)
        return cur.rowcount == 1


def finish_job(job_id: str, worker_id: str, result: dict | None = None) -> bool:
    result = result or {}
    outcome = result.get("status") if result.get("status") in {"partial", "failed"} else "succeeded"
    with connect() as c:
        cur = c.execute("""UPDATE collector_jobs SET status=?,result=?,lease_owner=NULL,
          lease_until=NULL,error=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=?""",
          (outcome,json.dumps(result,ensure_ascii=False),result.get("error"),int(time.time()),job_id,worker_id))
        if cur.rowcount:
            event(c,job_id,outcome,{})
        return cur.rowcount == 1


def fail_job(job_id: str, worker_id: str, error: str, retryable: bool = True) -> bool:
    now = int(time.time())
    with connect() as c:
        row = c.execute("SELECT attempt,max_attempts FROM collector_jobs WHERE id=? AND status='running' AND lease_owner=?", (job_id,worker_id)).fetchone()
        if not row:
            return False
        retry = retryable and row["attempt"] < row["max_attempts"]
        delay = min(3600, 15 * (2 ** max(0,row["attempt"] - 1)))
        status = "queued" if retry else "failed"
        c.execute("""UPDATE collector_jobs SET status=?,available_at=?,error=?,lease_owner=NULL,
          lease_until=NULL,updated_at=? WHERE id=?""",
          (status,now+delay if retry else now,str(error)[:500],now,job_id))
        event(c,job_id,"retry_scheduled" if retry else "dead_letter",{"error":str(error)[:500],"retry_at":now+delay if retry else None})
        return True


def retry_job(job_id: str) -> bool:
    now = int(time.time())
    with connect() as c:
        cur = c.execute("""UPDATE collector_jobs SET status='queued',attempt=0,available_at=?,lease_owner=NULL,
          lease_until=NULL,error=NULL,result=NULL,cancelled_at=NULL,updated_at=?
          WHERE id=? AND status IN ('failed','partial')""", (now,now,job_id))
        if cur.rowcount:
            event(c,job_id,"manual_retry",{})
        return cur.rowcount == 1


def cancel_job(job_id: str) -> bool:
    now = int(time.time())
    with connect() as c:
        row = c.execute("SELECT status FROM collector_jobs WHERE id=?", (job_id,)).fetchone()
        if not row or row["status"] not in {"queued", "running"}:
            return False
        target = "cancelled" if row["status"] == "queued" else "cancel_requested"
        cur = c.execute("""UPDATE collector_jobs SET status=?,cancelled_at=?,lease_owner=CASE WHEN ?='cancelled' THEN NULL ELSE lease_owner END,
          lease_until=CASE WHEN ?='cancelled' THEN NULL ELSE lease_until END,updated_at=? WHERE id=? AND status=?""",
          (target,now,target,target,now,job_id,row["status"]))
        if cur.rowcount:
            event(c,job_id,"cancelled" if target == "cancelled" else "cancel_requested",{})
        return cur.rowcount == 1


def job_cancelled(job_id: str) -> bool:
    with connect() as c:
        row = c.execute("SELECT status FROM collector_jobs WHERE id=?", (job_id,)).fetchone()
    return bool(row and row["status"] in {"cancel_requested", "cancelled"})


def mark_cancelled(job_id: str, worker_id: str) -> bool:
    now = int(time.time())
    with connect() as c:
        cur = c.execute("""UPDATE collector_jobs SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=?
          WHERE id=? AND lease_owner=? AND status IN ('running','cancel_requested')""", (now,job_id,worker_id))
        if cur.rowcount:
            event(c,job_id,"cancelled",{})
        return cur.rowcount == 1


class JobCancelled(Exception):
    pass


def run_worker(worker_id: str, handler: Callable[[dict, Callable[[dict], bool]], dict], once: bool = False, idle_seconds: float = 2.0) -> None:
    while True:
        job = claim_job(worker_id, lease_seconds=900)
        if not job:
            if once:
                return
            time.sleep(idle_seconds)
            continue
        try:
            payload = json.loads(job["payload"])
            payload["_job_type"] = job["job_type"]
            result = handler(
                payload,
                lambda value: checkpoint_job(job["id"],worker_id,value),
                lambda: job_cancelled(job["id"]),
            )
            if job_cancelled(job["id"]):
                mark_cancelled(job["id"],worker_id)
            else:
                finish_job(job["id"],worker_id,result if isinstance(result,dict) else {})
        except JobCancelled:
            mark_cancelled(job["id"],worker_id)
        except Exception as exc:
            fail_job(job["id"],worker_id,type(exc).__name__)
        if once:
            return


def safe_json(value: str | None) -> dict:
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed,dict) else {}
    except (TypeError,ValueError):
        return {}


def upsert_resource(payload: dict) -> dict:
    resource_type = payload.get("resource_type")
    if resource_type not in {"CMS_VOD","DIRECT_MEDIA","EMBEDDED_PLAYER"}:
        raise ValueError("Invalid resource_type")
    url = payload.get("url")
    if not isinstance(url,str) or not url.startswith("https://") or len(url)>4096:
        raise ValueError("Only bounded HTTPS resource URLs are accepted")
    source_key = str(payload.get("source_key") or "unknown")[:200]
    external_movie = payload.get("movie_external_key")
    external_episode = payload.get("episode_external_key")
    title = str(payload.get("title") or "")[:200]
    if not title:
        raise ValueError("Resource title is required")
    now = int(time.time())
    resource_key = str(payload.get("resource_key") or hashlib.sha256((source_key+"|"+url).encode()).hexdigest())
    movie_id = episode_id = source_id = None
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        if external_movie:
            movie_id = "m_"+hashlib.sha256(str(external_movie).encode()).hexdigest()[:28]
            c.execute("""INSERT INTO registry_movies(id,external_key,title,year,metadata,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(external_key) DO UPDATE SET title=excluded.title,year=COALESCE(excluded.year,registry_movies.year),metadata=excluded.metadata,updated_at=excluded.updated_at""",
              (movie_id,str(external_movie),str(payload.get("movie_title") or title)[:200],payload.get("year"),json.dumps(payload.get("movie_metadata") or {}),now,now))
            movie_id = c.execute("SELECT id FROM registry_movies WHERE external_key=?", (str(external_movie),)).fetchone()["id"]
        if external_episode:
            if not movie_id:
                raise ValueError("Episode requires a stable movie_external_key")
            episode_id = "e_"+hashlib.sha256(str(external_episode).encode()).hexdigest()[:28]
            c.execute("""INSERT INTO registry_episodes(id,movie_id,external_key,season,episode,title,metadata,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(external_key) DO UPDATE SET movie_id=excluded.movie_id,season=excluded.season,episode=excluded.episode,title=excluded.title,metadata=excluded.metadata,updated_at=excluded.updated_at""",
              (episode_id,movie_id,str(external_episode),payload.get("season"),payload.get("episode"),str(payload.get("episode_title") or title)[:200],json.dumps({}),now,now))
            episode_id = c.execute("SELECT id FROM registry_episodes WHERE external_key=?", (str(external_episode),)).fetchone()["id"]
        source_id = "s_"+hashlib.sha256(source_key.encode()).hexdigest()[:28]
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        c.execute("""INSERT INTO registry_sources(id,source_key,name,host,metadata,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,host=excluded.host,updated_at=excluded.updated_at""",
          (source_id,source_key,str(payload.get("source_name") or source_key)[:160],host,json.dumps({}),now,now))
        before = c.execute("SELECT * FROM registry_resources WHERE resource_key=?", (resource_key,)).fetchone()
        resource_id = before["id"] if before else "r_"+hashlib.sha256(resource_key.encode()).hexdigest()[:28]
        c.execute("""INSERT INTO registry_resources(id,resource_key,movie_id,episode_id,source_id,candidate_id,
          resource_type,url,title,access_state,validation_state,playback_state,media_format,metadata,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET
          movie_id=excluded.movie_id,episode_id=excluded.episode_id,source_id=excluded.source_id,candidate_id=excluded.candidate_id,
          resource_type=excluded.resource_type,url=excluded.url,title=excluded.title,access_state=excluded.access_state,
          media_format=excluded.media_format,metadata=excluded.metadata,updated_at=excluded.updated_at""",
          (resource_id,resource_key,movie_id,episode_id,source_id,payload.get("candidate_id"),resource_type,url,title,
           payload.get("access_state","ACCESS_UNKNOWN"),"unverified","unverified",payload.get("media_format"),json.dumps(payload.get("metadata") or {}),now,now))
        after = c.execute("SELECT * FROM registry_resources WHERE id=?", (resource_id,)).fetchone()
        if not before or dict(before) != dict(after):
            c.execute("INSERT INTO registry_history(id,resource_id,action,before_state,after_state,created_at) VALUES(?,?,?,?,?,?)",
              (uuid.uuid4().hex,resource_id,"upsert",json.dumps(dict(before) if before else {}),json.dumps(dict(after)),now))
        c.commit()
    return dict(after)


def record_verification(resource_id: str, kind: str, outcome: str, evidence: dict) -> dict:
    if kind not in {"preflight","player"} or outcome not in {"passed","failed","blocked"}:
        raise ValueError("Invalid verification")
    now = int(time.time())
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM registry_resources WHERE id=?", (resource_id,)).fetchone()
        if not row:
            raise KeyError(resource_id)
        if kind == "player" and (row["validation_state"] != "validated" or row["access_state"] != "PUBLIC" or outcome != "passed"):
            raise ValueError("Player confirmation requires a validated PUBLIC resource")
        before = dict(row)
        if kind == "preflight":
            access = evidence.get("access_state","ACCESS_UNKNOWN")
            state = "validated" if outcome == "passed" and access == "PUBLIC" else ("rejected" if outcome == "failed" else "blocked")
            c.execute("UPDATE registry_resources SET validation_state=?,access_state=?,updated_at=? WHERE id=?",(state,access,now,resource_id))
        else:
            c.execute("UPDATE registry_resources SET playback_state='PLAYER_CONFIRMED',updated_at=? WHERE id=?",(now,resource_id))
        after = dict(c.execute("SELECT * FROM registry_resources WHERE id=?",(resource_id,)).fetchone())
        c.execute("INSERT INTO registry_verifications(id,resource_id,verification_type,outcome,evidence,created_at) VALUES(?,?,?,?,?,?)",
          (uuid.uuid4().hex,resource_id,kind,outcome,json.dumps(evidence,ensure_ascii=False),now))
        c.execute("INSERT INTO registry_history(id,resource_id,action,before_state,after_state,created_at) VALUES(?,?,?,?,?,?)",
          (uuid.uuid4().hex,resource_id,kind,json.dumps(before),json.dumps(after),now))
        c.commit()
    return after


def register_discovered_candidate(candidate: dict) -> dict | None:
    kind = candidate.get("kind")
    resource_type = {
        "cms-api-candidate": "CMS_VOD",
        "direct-media": "DIRECT_MEDIA",
        "embedded-player": "EMBEDDED_PLAYER",
    }.get(kind)
    if not resource_type:
        return None
    return upsert_resource({
        "resource_key": "candidate:"+str(candidate["id"]),
        "candidate_id": candidate["id"],
        "source_key": candidate.get("host") or "unknown",
        "source_name": candidate.get("host") or "Unknown source",
        "resource_type": resource_type,
        "url": candidate["url"],
        "title": candidate.get("title") or candidate.get("host") or "Untitled resource",
        "access_state": candidate.get("access_state") or "ACCESS_UNKNOWN",
        "metadata": {
            "discovery_status": candidate.get("status", "pending"),
            "search_keyword": str(candidate.get("search_keyword") or "")[:100],
        },
    })


def sync_candidate_validation(candidate_id: str, validation: dict, status: str) -> None:
    with connect() as c:
        row = c.execute("SELECT id FROM registry_resources WHERE resource_key=?", ("candidate:"+candidate_id,)).fetchone()
    if not row:
        return
    access = validation.get("access") or {}
    access_state = access.get("access_state") or "ACCESS_UNKNOWN"
    outcome = "passed" if status == "validated" and access_state == "PUBLIC" else ("failed" if status == "rejected" else "blocked")
    raw_format = validation.get("media_format")
    content_type = str(validation.get("content_type") or "").lower()
    media_format = "hls" if raw_format == "hls" else (
        "webm" if "webm" in content_type else ("mp4" if raw_format == "progressive" else None)
    )
    with connect() as c:
        c.execute("UPDATE registry_resources SET media_format=?,updated_at=? WHERE id=?",
                  (media_format,int(time.time()),row["id"]))
    record_verification(row["id"], "preflight", outcome, {
        "access_state": access_state,
        "reachable": validation.get("reachable"),
        "media_format": media_format,
        "candidate_id": candidate_id,
    })


def register_candidate_playback(candidate_id: str, evidence: dict) -> dict:
    # Called by the existing candidate playback endpoint after its strict preflight checks.
    with connect() as c:
        row = c.execute("SELECT * FROM candidates WHERE id=?", (candidate_id,)).fetchone()
    if not row:
        raise KeyError(candidate_id)
    validation = safe_json(row["validation"])
    media_format = validation.get("media_format")
    resource_type = "DIRECT_MEDIA" if row["kind"] == "direct-media" else "EMBEDDED_PLAYER"
    resource = upsert_resource({
        "resource_key": "candidate:"+candidate_id, "candidate_id": candidate_id,
        "source_key": row["host"], "source_name": row["host"], "resource_type": resource_type,
        "url": row["url"], "title": row["title"] or row["host"], "access_state": row["access_state"],
        "media_format": evidence.get("media_type") or media_format,
    })
    record_verification(resource["id"],"preflight","passed",{"access_state":"PUBLIC","source":"candidate_validation"})
    result = record_verification(resource["id"],"player","passed",evidence)
    return {"resource":result}


@router.post("/v1/tasks/submit")
def api_submit_job(payload: dict, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    request = payload.get("payload")
    job_type = str(payload.get("job_type") or "crawl")
    if not isinstance(request,dict):
        raise HTTPException(status_code=400,detail="A job payload is required")
    if job_type == "discover":
        if "url" in request:
            raise HTTPException(status_code=400,detail="Discovery jobs use the fixed system directory")
    elif job_type == "crawl":
        if not isinstance(request.get("url"),str):
            raise HTTPException(status_code=400,detail="A crawl payload with URL is required")
    else:
        raise HTTPException(status_code=400,detail="Unsupported job type; SeedHub collection has been retired")
    key = str(payload.get("idempotency_key") or "")
    try:
        return submit_job(job_type,request,key)
    except ValueError as exc:
        raise HTTPException(status_code=400,detail=str(exc))


@router.get("/v1/sites")
def api_sites(
    authorization: str | None = Header(default=None),
    limit: int = Query(default=30, ge=1, le=100),
):
    """Return only the persisted public-site discovery allowlist for bounded Agent selection."""
    require_auth(authorization)
    with connect() as conn:
        table = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sites'").fetchone()
        if not table:
            return {"sites": []}
        rows = conn.execute(
            "SELECT host,title,url,directory,discovered_at FROM sites ORDER BY discovered_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"sites": [dict(row) for row in rows]}


@router.get("/v1/jobs")
def api_jobs(authorization: str | None = Header(default=None), limit: int = Query(default=50,ge=1,le=100)):
    require_auth(authorization)
    with connect() as c:
        rows=c.execute("SELECT * FROM collector_jobs ORDER BY created_at DESC LIMIT ?",(limit,)).fetchall()
    return {"jobs":[dict(r) for r in rows]}


@router.get("/v1/jobs/{job_id}")
def api_job(job_id: str, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    with connect() as c:
        row=c.execute("SELECT * FROM collector_jobs WHERE id=?",(job_id,)).fetchone()
        events=c.execute("SELECT event,detail,created_at FROM collector_job_events WHERE job_id=? ORDER BY created_at",(job_id,)).fetchall()
    if not row: raise HTTPException(status_code=404,detail="Job not found")
    result=dict(row); result["events"]=[dict(e) for e in events]
    return result


@router.post("/v1/jobs/{job_id}/retry")
def api_retry_job(job_id: str, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    if not retry_job(job_id):
        raise HTTPException(status_code=409, detail="Only failed or partial jobs can be retried")
    return {"job_id": job_id, "status": "queued"}


@router.post("/v1/jobs/{job_id}/cancel")
def api_cancel_job(job_id: str, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    if not cancel_job(job_id): raise HTTPException(status_code=409,detail="Job is not cancellable")
    with connect() as c:
        row = c.execute("SELECT status FROM collector_jobs WHERE id=?", (job_id,)).fetchone()
    return {"job_id":job_id,"status":row["status"] if row else "unknown"}


@router.get("/v1/registry/search")
def api_registry_search(q: str = "", authorization: str | None = Header(default=None)):
    require_auth(authorization)
    term = q.strip()[:100]
    with connect() as c:
        rows = c.execute("""SELECT r.*,s.name AS source_name,s.host AS source_host
          FROM registry_resources r LEFT JOIN registry_sources s ON s.id=r.source_id
          WHERE r.validation_state='validated'
            AND r.access_state='PUBLIC'
            AND r.resource_type='DIRECT_MEDIA'
            AND r.media_format IN ('hls','mp4','webm')
            AND (r.title LIKE ? OR r.resource_key LIKE ? OR r.metadata LIKE ?)
          ORDER BY CASE WHEN r.playback_state='PLAYER_CONFIRMED' THEN 0 ELSE 1 END,
                   r.updated_at DESC LIMIT 30""", (f"%{term}%",f"%{term}%",f"%{term}%")).fetchall() if term else []
        sites = c.execute("SELECT host,url FROM sites ORDER BY discovered_at DESC LIMIT 5").fetchall() if term and not rows else []

    scheduled = []
    if not rows and term:
        # Search misses enqueue bounded crawls of FMHY-discovered public sites.
        if not sites:
            key = "registry-discover:"+hashlib.sha256(term.lower().encode()).hexdigest()
            job = submit_job("discover", {"search_keyword":term}, key)
            scheduled.append({"job_id":job["id"],"stage":"fmhy_discovery"})
        for site in sites:
            key = "registry-search:"+hashlib.sha256((term.lower()+"|"+site["host"]).encode()).hexdigest()
            job = submit_job("crawl", {"url":site["url"],"mode":"auto","limit":50,"search_keyword":term}, key)
            scheduled.append({"job_id":job["id"],"host":site["host"]})
    return {"resources":[dict(row) for row in rows],"queued":scheduled,"search_mode":"playback_eligible_registry"}


@router.post("/v1/registry/resources")
def api_upsert_resource(payload: dict, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    try: return upsert_resource(payload)
    except ValueError as exc: raise HTTPException(status_code=400,detail=str(exc))


@router.get("/v1/registry/resources")
def api_search_resources(q: str = "", verified_only: bool = True, limit: int = Query(default=30,ge=1,le=100), authorization: str | None = Header(default=None)):
    require_auth(authorization)
    with connect() as c:
        sql = "SELECT r.*,s.name AS source_name,s.host AS source_host FROM registry_resources r LEFT JOIN registry_sources s ON s.id=r.source_id WHERE 1=1"
        args: list[Any] = []
        if verified_only: sql += " AND r.validation_state='validated' AND r.playback_state='PLAYER_CONFIRMED' AND r.access_state='PUBLIC' AND r.resource_type='DIRECT_MEDIA' AND r.media_format IN ('hls','mp4','webm')"
        if q.strip(): sql += " AND (r.title LIKE ? OR r.resource_key LIKE ?)"; args.extend([f"%{q[:100]}%",f"%{q[:100]}%"])
        rows=c.execute(sql+" ORDER BY r.updated_at DESC LIMIT ?",(*args,limit)).fetchall()
    return {"resources":[dict(r) for r in rows]}


@router.get("/v1/registry/resources/{resource_id}")
def api_get_resource(resource_id: str, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    with connect() as c:
        row=c.execute("SELECT * FROM registry_resources WHERE id=?",(resource_id,)).fetchone()
        verifications=c.execute("SELECT * FROM registry_verifications WHERE resource_id=? ORDER BY created_at DESC",(resource_id,)).fetchall()
        history=c.execute("SELECT * FROM registry_history WHERE resource_id=? ORDER BY created_at DESC",(resource_id,)).fetchall()
    if not row: raise HTTPException(status_code=404,detail="Resource not found")
    return {"resource":dict(row),"verifications":[dict(v) for v in verifications],"history":[dict(h) for h in history]}


@router.post("/v1/registry/resources/{resource_id}/verifications")
def api_verify_resource(resource_id: str, payload: dict, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    if payload.get("type") == "player":
        raise HTTPException(status_code=409, detail="Player verification is accepted only through the candidate playback evidence endpoint")
    try: return record_verification(resource_id,str(payload.get("type")),str(payload.get("outcome")),payload.get("evidence") or {})
    except KeyError: raise HTTPException(status_code=404,detail="Resource not found")
    except ValueError as exc: raise HTTPException(status_code=409,detail=str(exc))


initialize()
