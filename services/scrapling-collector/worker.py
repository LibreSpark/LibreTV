from __future__ import annotations

import hashlib
import argparse
import os
import uuid

from app import (
    TOKEN,
    CrawlRequest,
    crawl_site,
    discover_sites,
    require_egress_firewall,
    task_candidates,
    validate_candidate,
)
from registry_queue import JobCancelled, run_worker, submit_job

# Bound automatic network validation per crawl so one discovered site cannot
# trigger an unbounded number of outbound media probes.
MAX_AUTOMATIC_MEDIA_PREFLIGHTS = 20


def handle(payload: dict, checkpoint, cancelled):
    if cancelled():
        raise JobCancelled()
    if payload.get("_job_type") == "discover":
        require_egress_firewall()
        checkpoint({"stage": "fmhy_discovery_started"})
        sites = discover_sites()
        if cancelled():
            raise JobCancelled()
        keyword = str(payload.get("search_keyword") or "")[:50]
        queued = []
        for site in sites[:5]:
            key = "registry-search:"+hashlib.sha256((keyword.lower()+"|"+site["host"]).encode()).hexdigest()
            job = submit_job("crawl", {"url":site["url"],"mode":"auto","limit":50,"search_keyword":keyword}, key)
            queued.append(job["id"])
        checkpoint({"stage": "fmhy_sites_registered", "discovered": len(sites), "queued_jobs": len(queued)})
        return {"status": "succeeded", "discovered": len(sites), "queued_jobs": queued}

    checkpoint({"stage": "crawl_started"})
    result = crawl_site(CrawlRequest(**payload), cancel_check=cancelled)
    if cancelled():
        raise JobCancelled()

    task_id = result.get("task_id")
    candidates = task_candidates(task_id, f"Bearer {TOKEN}").get("candidates", []) if task_id else []
    media_candidates = [
        item for item in candidates
        if item.get("kind") == "direct-media" and item.get("status") == "pending"
    ][:MAX_AUTOMATIC_MEDIA_PREFLIGHTS]
    checkpoint({
        "stage": "media_preflight_started",
        "candidate_count": len(candidates),
        "media_candidates": len(media_candidates),
    })

    preflight = {"checked": 0, "validated": 0, "rejected": 0, "errors": []}
    for candidate in media_candidates:
        if cancelled():
            raise JobCancelled()
        try:
            validation_result = validate_candidate(candidate["id"], f"Bearer {TOKEN}")
            validation = validation_result.get("validation", {})
            preflight["checked"] += 1
            if validation.get("reachable") is True and (validation.get("access") or {}).get("access_state") == "PUBLIC":
                preflight["validated"] += 1
            else:
                preflight["rejected"] += 1
        except Exception as exc:
            preflight["errors"].append({
                "candidate_id": candidate.get("id"),
                "error": type(exc).__name__,
            })
    checkpoint({
        "stage": "media_preflight_completed",
        "checked": preflight["checked"],
        "validated": preflight["validated"],
        "rejected": preflight["rejected"],
        "errors": len(preflight["errors"]),
    })
    result["preflight"] = preflight
    result["registry_ready"] = preflight["validated"]
    checkpoint({
        "stage": "candidates_persisted",
        "count": result.get("count", 0),
        "task_id": task_id,
        "registry_ready": preflight["validated"],
    })
    return result


def main():
    parser = argparse.ArgumentParser(description="LibreTV durable Scrapling job worker")
    parser.add_argument("--once", action="store_true", help="claim at most one job and exit")
    parser.add_argument("--worker-id", default=f"collector-{uuid.uuid4().hex[:8]}")
    args = parser.parse_args()
    if not os.environ.get("SCRAPLING_API_TOKEN", "").strip():
        parser.error("SCRAPLING_API_TOKEN must be configured")
    run_worker(args.worker_id, handle, once=args.once)


if __name__ == "__main__":
    main()
