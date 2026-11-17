from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
import socket
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

from app.batch_store import MAX_MEDIA_PROBE_BYTES_PER_CANDIDATE, PostgresBatchStore
from app.candidate_store import PostgresCandidateStore
from app.config import settings
from app.discovery import extract_discovery_links, is_same_origin
from app.media_analyzer import analyze_hls_manifest, analyze_mpd_manifest
from app.media_downloader import MAX_MEDIA_FILE_BYTES, download_candidate_media
from app.probe_client import probe_media_file
from app.robots import ensure_robots_allowed
from app.rule_store import PostgresRuleStore
from app.scraper import ScraplingAdapter
from app.security import validate_public_http_url
from app.spider import ScraplingSpiderAdapter
from app.supervisor import RetryableSupervisorError, SupervisorClient
from app.workflow_store import PostgresWorkflowStore

logger = logging.getLogger("libretv.scrapling.workflow_worker")
NodeHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class WorkflowWorker:
    """Executes durable DAG nodes with independent leases and retryable failures."""

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
        # Compose service names are stable across restarts. Add a per-process nonce so
        # a restarted instance cannot accidentally reuse an expired lease owner ID.
        self.worker_id = f"{worker_id}:{uuid.uuid4().hex}"
        self.lease_seconds = lease_seconds
        self.poll_seconds = poll_seconds
        self.store = PostgresWorkflowStore(database_url)
        self.candidates = PostgresCandidateStore(database_url)
        self.batches = PostgresBatchStore(database_url, self.store)
        self.rules = PostgresRuleStore(database_url)
        self.handlers: dict[str, NodeHandler] = {
            "validate_public_urls": self._validate_public_urls,
            "crawl_seed_urls": self._crawl_seed_urls,
            "discover_site_links": self._discover_site_links,
            "autonomous_site_discovery": self._autonomous_site_discovery,
            "ai_supervisor_discover": self._ai_supervisor_discover,
            "generate_extraction_rule": self._generate_extraction_rule,
            "register_candidates": self._register_candidates,
            "probe_local_media_file": self._probe_local_media_file,
            "probe_media_candidates": self._probe_media_candidates,
            "analyze_media_manifest": self._analyze_media_manifest,
            "analyze_media_candidates": self._analyze_media_candidates,
        }

    @staticmethod
    def _dependency_urls(payload: dict[str, Any]) -> list[str]:
        dependencies = payload.get("dependencies", {})
        for result in dependencies.values():
            if isinstance(result, dict) and isinstance(result.get("urls"), list):
                return result["urls"]
        return []

    async def _validate_public_urls(self, payload: dict[str, Any]) -> dict[str, Any]:
        urls = payload.get("urls") or self._dependency_urls(payload)
        if not isinstance(urls, list) or not urls or len(urls) > 20:
            raise ValueError("validate_public_urls requires 1 to 20 URLs")
        safe_urls = list(dict.fromkeys(validate_public_http_url(url) for url in urls))
        return {"urls": safe_urls, "validated_count": len(safe_urls)}

    async def _crawl_seed_urls(self, payload: dict[str, Any]) -> dict[str, Any]:
        urls = payload.get("urls") or self._dependency_urls(payload)
        if not isinstance(urls, list) or not urls or len(urls) > 20:
            raise ValueError("crawl_seed_urls requires 1 to 20 URLs")
        safe_urls = list(dict.fromkeys(validate_public_http_url(url) for url in urls))
        spider = ScraplingSpiderAdapter.create(safe_urls)
        items: list[dict[str, Any]] = []
        async for item in spider.stream():
            items.append(item)
        return {
            "items": items,
            "stats": asdict(spider.stats),
            "count": len(items),
        }

    async def _discover_site_links(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Bounded same-origin breadth-first discovery; no arbitrary domain expansion."""
        urls = payload.get("urls") or self._dependency_urls(payload)
        if not isinstance(urls, list) or not urls or len(urls) > 20:
            raise ValueError("discover_site_links requires 1 to 20 seed URLs")
        max_pages = payload.get("max_pages", 50)
        max_depth = payload.get("max_depth", 2)
        max_links_per_page = payload.get("max_links_per_page", 30)
        if (
            not isinstance(max_pages, int)
            or isinstance(max_pages, bool)
            or not 1 <= max_pages <= 200
        ):
            raise ValueError("max_pages must be an integer from 1 to 200")
        if not isinstance(max_depth, int) or isinstance(max_depth, bool) or not 0 <= max_depth <= 5:
            raise ValueError("max_depth must be an integer from 0 to 5")
        if (
            not isinstance(max_links_per_page, int)
            or isinstance(max_links_per_page, bool)
            or not 1 <= max_links_per_page <= 50
        ):
            raise ValueError("max_links_per_page must be an integer from 1 to 50")

        seeds = list(dict.fromkeys(validate_public_http_url(url) for url in urls))
        checkpoint = payload.get("_resume_checkpoint")
        queue: list[tuple[str, int]] = [(url, 0) for url in seeds]
        queued = set(seeds)
        visited: set[str] = set()
        items: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        if isinstance(checkpoint, dict):
            saved_visited = checkpoint.get("visited")
            if isinstance(saved_visited, list):
                visited = {
                    target
                    for target in saved_visited
                    if isinstance(target, str)
                    and any(is_same_origin(target, seed) for seed in seeds)
                }
            saved_queue = checkpoint.get("queue")
            if isinstance(saved_queue, list):
                queue = []
                for entry in saved_queue:
                    if (
                        isinstance(entry, list)
                        and len(entry) == 2
                        and isinstance(entry[0], str)
                        and isinstance(entry[1], int)
                        and any(is_same_origin(entry[0], seed) for seed in seeds)
                    ):
                        queue.append((entry[0], max(0, min(entry[1], max_depth))))
            saved_queued = checkpoint.get("queued")
            if isinstance(saved_queued, list):
                queued = {
                    target
                    for target in saved_queued
                    if isinstance(target, str)
                    and any(is_same_origin(target, seed) for seed in seeds)
                }
            saved_items = checkpoint.get("items")
            if isinstance(saved_items, list):
                items = [item for item in saved_items if isinstance(item, dict)][:max_pages]
            saved_errors = checkpoint.get("errors")
            if isinstance(saved_errors, list):
                errors = [item for item in saved_errors if isinstance(item, dict)][:100]
            if not queue:
                queue = [(url, 0) for url in seeds if url not in visited]
        if not queue and not visited:
            queue = [(url, 0) for url in seeds]
        media_extensions = (".m3u8", ".mpd", ".mp4", ".m4v", ".webm", ".mov", ".ts", ".mkv")
        active_rules_by_origin: dict[str, list[dict[str, Any]]] = {}
        for seed in seeds:
            parsed_seed = urlsplit(seed)
            seed_origin = f"{parsed_seed.scheme.lower()}://{parsed_seed.netloc.lower()}"
            if seed_origin not in active_rules_by_origin:
                active_rules_by_origin[seed_origin] = await asyncio.to_thread(
                    self.rules.list_active_for_origin,
                    seed,
                )

        while queue and len(visited) < max_pages:
            url, depth = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)
            try:
                await asyncio.to_thread(
                    ensure_robots_allowed,
                    url,
                    settings.request_timeout_seconds,
                )
                page = await asyncio.to_thread(
                    ScraplingAdapter.fetch_page,
                    url,
                    settings.request_timeout_seconds,
                )
                final_url = validate_public_http_url(str(getattr(page, "url", None) or url))
                # A public redirect must not silently widen the discovery scope.
                if not is_same_origin(final_url, url):
                    errors.append({"url": url, "error": "cross_origin_redirect"})
                    continue
                headers = getattr(page, "headers", {}) or {}
                content_type = headers.get("content-type", "") if hasattr(headers, "get") else ""
                if content_type and "html" not in str(content_type).lower():
                    continue

                title_node = page.css_first("title::text")
                raw_media = page.css("video::attr(src), source::attr(src)").getall()
                raw_media.extend(page.css("a::attr(href)").getall())
                media_urls: list[str] = []
                for raw in raw_media:
                    if not isinstance(raw, str):
                        continue
                    absolute = urljoin(final_url, raw.strip())
                    if urlsplit(absolute).path.lower().endswith(media_extensions):
                        safe_media = validate_public_http_url(absolute)
                        if safe_media not in media_urls and len(media_urls) < 20:
                            media_urls.append(safe_media)

                parsed_final = urlsplit(final_url)
                final_origin = f"{parsed_final.scheme.lower()}://{parsed_final.netloc.lower()}"
                rule_extractions: list[dict[str, Any]] = []
                for active_rule in active_rules_by_origin.get(final_origin, []):
                    try:
                        matched = await asyncio.to_thread(
                            ScraplingAdapter.extract,
                            page,
                            active_rule["selector"],
                            active_rule["mode"],
                        )
                        match_count = matched.get("count", 0)
                        values = matched.get("text", [])
                        if not isinstance(match_count, int) or isinstance(match_count, bool):
                            match_count = 0
                        if not isinstance(values, list):
                            values = []
                        feedback = await asyncio.to_thread(
                            self.rules.record_execution,
                            active_rule["rule_id"],
                            passed=match_count > 0,
                            match_count=match_count,
                            sample_values=[str(value) for value in values[:5]],
                            workflow_id=str(payload.get("_workflow_id") or "manual"),
                            page_url=final_url,
                        )
                        rule_extractions.append(
                            {
                                "rule_id": active_rule["rule_id"],
                                "version": active_rule["version"],
                                "goal": active_rule["goal"],
                                "values": values[:20],
                                "match_count": match_count,
                                "status": "matched" if match_count > 0 else "no_matches",
                                "failure_streak": feedback["failure_streak"],
                                "auto_disabled": feedback["auto_disabled"],
                            }
                        )
                        if feedback["auto_disabled"]:
                            active_rules_by_origin[final_origin] = [
                                rule
                                for rule in active_rules_by_origin.get(final_origin, [])
                                if rule["rule_id"] != active_rule["rule_id"]
                            ]
                    except Exception as exc:
                        logger.warning(
                            "Active extraction rule %s failed: %s",
                            active_rule["rule_id"],
                            type(exc).__name__,
                        )
                        feedback = await asyncio.to_thread(
                            self.rules.record_execution,
                            active_rule["rule_id"],
                            passed=False,
                            match_count=0,
                            sample_values=[],
                            workflow_id=str(payload.get("_workflow_id") or "manual"),
                            page_url=final_url,
                            error=type(exc).__name__,
                        )
                        rule_extractions.append(
                            {
                                "rule_id": active_rule["rule_id"],
                                "version": active_rule["version"],
                                "status": "execution_failed",
                                "failure_streak": feedback["failure_streak"],
                                "auto_disabled": feedback["auto_disabled"],
                            }
                        )
                        if feedback["auto_disabled"]:
                            active_rules_by_origin[final_origin] = [
                                rule
                                for rule in active_rules_by_origin.get(final_origin, [])
                                if rule["rule_id"] != active_rule["rule_id"]
                            ]

                items.append(
                    {
                        "url": final_url,
                        "status": getattr(page, "status", None),
                        "title": title_node.get().strip() if title_node else "",
                        "text": page.get_all_text(strip=True)[:5_000],
                        "media_urls": media_urls,
                        "rule_extractions": rule_extractions,
                        "depth": depth,
                    }
                )
                if depth < max_depth and len(visited) + len(queue) < max_pages:
                    links = extract_discovery_links(
                        page,
                        final_url,
                        max_links=max_links_per_page,
                        same_origin_only=True,
                    )
                    for link in links:
                        if link not in queued and len(visited) + len(queue) < max_pages:
                            queued.add(link)
                            queue.append((link, depth + 1))
            except Exception as exc:
                logger.warning("Discovery failed for %s: %s", url, type(exc).__name__)
                errors.append({"url": url, "error": type(exc).__name__})
            save_checkpoint = payload.get("_save_checkpoint")
            if callable(save_checkpoint):
                checkpoint_items = [
                    {**item, "text": str(item.get("text", ""))[:3_000]} for item in items
                ]
                await save_checkpoint(
                    {
                        "queue": [[queued_url, depth] for queued_url, depth in queue],
                        "queued": sorted(queued),
                        "visited": sorted(visited),
                        "items": checkpoint_items,
                        "errors": errors[-100:],
                    }
                )
            if queue and len(visited) < max_pages:
                await asyncio.sleep(1.0)

        return {
            "items": items,
            "count": len(items),
            "visited_count": len(visited),
            "queued_count": len(queue),
            "max_depth": max_depth,
            "max_pages": max_pages,
            "scope": "same_origin_only",
            "errors": errors[:100],
        }

    async def _autonomous_site_discovery(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Discover public sites from approved public directories and build candidate resources."""
        catalog_urls = payload.get("catalog_urls")
        if not isinstance(catalog_urls, list) or not 1 <= len(catalog_urls) <= 5:
            raise ValueError("autonomous_site_discovery requires 1 to 5 catalog URLs")
        max_sites = payload.get("max_sites", 10)
        if (
            not isinstance(max_sites, int)
            or isinstance(max_sites, bool)
            or not 1 <= max_sites <= 20
        ):
            raise ValueError("max_sites must be an integer from 1 to 20")
        goal = str(payload.get("goal", "Discover public movie, series and animation resources."))
        if not goal.strip() or len(goal) > 1000:
            raise ValueError("Discovery goal must contain 1 to 1000 characters")

        catalog_pages: list[tuple[str, object]] = []
        discovered_origins: dict[str, str] = {}
        catalog_errors: list[dict[str, str]] = []
        for raw_catalog_url in catalog_urls:
            if not isinstance(raw_catalog_url, str):
                continue
            catalog_url = validate_public_http_url(raw_catalog_url)
            try:
                await asyncio.to_thread(
                    ensure_robots_allowed, catalog_url, settings.request_timeout_seconds
                )
                page = await asyncio.to_thread(
                    ScraplingAdapter.fetch_page, catalog_url, settings.request_timeout_seconds
                )
                final_url = validate_public_http_url(str(getattr(page, "url", None) or catalog_url))
                if not is_same_origin(final_url, catalog_url):
                    raise ValueError("catalog_redirect_outside_origin")
                content_type = (getattr(page, "headers", {}) or {}).get("content-type", "")
                if content_type and "html" not in str(content_type).lower():
                    raise ValueError("catalog_not_html")
                catalog_pages.append((final_url, page))
                for link in extract_discovery_links(
                    page, final_url, max_links=100, same_origin_only=False
                ):
                    parsed = urlsplit(link)
                    origin = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"
                    if (
                        origin
                        != f"{urlsplit(final_url).scheme.lower()}://{urlsplit(final_url).netloc.lower()}"
                    ):
                        discovered_origins.setdefault(origin, f"{origin}/")
            except Exception as exc:
                catalog_errors.append({"url": catalog_url, "error": type(exc).__name__})

        site_results: list[dict[str, Any]] = []
        workflow_id = str(payload.get("_workflow_id") or "manual")
        for site_url in list(discovered_origins.values())[:max_sites]:
            site_result: dict[str, Any] = {
                "site_url": site_url,
                "status": "discovered",
                "review_status": "candidate_only",
            }
            try:
                discovery = await self._ai_supervisor_discover({"urls": [site_url], "goal": goal})
                site_result["pages_discovered"] = discovery.get("count", 0)
                site_result["discovery_errors"] = discovery.get("errors", [])[:10]
                items = discovery.get("items", [])
                if items:
                    active_rules = await asyncio.to_thread(
                        self.rules.list_active_for_origin, str(items[0].get("url") or site_url)
                    )
                    rule_feedback = [
                        extraction
                        for item in items
                        if isinstance(item, dict)
                        for extraction in item.get("rule_extractions", [])
                        if isinstance(extraction, dict)
                    ]
                    repair_needed = not active_rules or any(
                        extraction.get("status") != "matched" or extraction.get("auto_disabled")
                        for extraction in rule_feedback
                    )
                    if repair_needed:
                        try:
                            rule_result = await self._generate_extraction_rule(
                                {
                                    "page_url": items[0].get("url"),
                                    "goal": goal,
                                    "_workflow_id": workflow_id,
                                }
                            )
                            site_result["rule"] = rule_result
                            site_result["rule_repair_status"] = (
                                "replacement_tested_pending_approval"
                                if active_rules
                                else "initial_rule_tested_pending_approval"
                            )
                        except Exception as exc:
                            site_result["rule_repair_status"] = "needs_review"
                            site_result["rule_error"] = type(exc).__name__
                    else:
                        site_result["rule_repair_status"] = "active_rule_healthy"
                    registered = await self._register_candidates(
                        {"_workflow_id": workflow_id, "items": items}
                    )
                    site_result["candidate_count"] = registered["count"]
                    site_result["candidate_ids"] = registered["candidate_ids"]
                    site_result["status"] = "candidates_registered"
                else:
                    site_result["status"] = "no_public_resources_found"
            except Exception as exc:
                site_result["status"] = "site_scan_failed"
                site_result["error"] = type(exc).__name__
            site_results.append(site_result)

        return {
            "catalog_count": len(catalog_pages),
            "discovered_site_count": len(discovered_origins),
            "scanned_site_count": len(site_results),
            "candidate_count": sum(int(site.get("candidate_count", 0)) for site in site_results),
            "sites": site_results,
            "catalog_errors": catalog_errors[:20],
            "review_gate": "resources_remain_pending_human_review; no formal publishing",
        }

    async def _ai_supervisor_discover(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Ask the configured model for bounded limits, then execute the safe discovery tool."""
        urls = payload.get("urls") or self._dependency_urls(payload)
        if not isinstance(urls, list) or not urls or len(urls) > 20:
            raise ValueError("ai_supervisor_discover requires 1 to 20 seed URLs")
        safe_urls = list(dict.fromkeys(validate_public_http_url(url) for url in urls))
        api_key = (
            settings.supervisor_api_key.get_secret_value()
            if settings.supervisor_api_key is not None
            else ""
        )
        planner = SupervisorClient(
            settings.supervisor_api_base,
            api_key,
            settings.supervisor_model,
            settings.supervisor_timeout_seconds,
            proxy=settings.egress_proxy_url,
        )
        goal = payload.get(
            "goal",
            (
                "Discover public movie, series and animation pages and identify "
                "direct media references."
            ),
        )
        plan = await planner.plan_discovery(str(goal), safe_urls)
        discovery = await self._discover_site_links(
            {"urls": safe_urls, **plan.model_dump(exclude={"rationale"})}
        )
        return {
            **discovery,
            "supervisor": {
                "model": planner.model,
                "rationale": plan.rationale,
                "selected_limits": plan.model_dump(),
                "executed_tool": "discover_site_links",
            },
        }

    async def _generate_extraction_rule(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self._generate_extraction_rule_impl(payload)
        except RetryableSupervisorError:
            # Provider/network outages must reach process_once so the durable DAG
            # can schedule a bounded retry instead of recording a false success.
            raise
        except Exception as exc:
            workflow_id = str(payload.get("_workflow_id") or "unknown")
            logger.info(
                "Optional extraction rule skipped for workflow %s: %s",
                workflow_id,
                type(exc).__name__,
            )
            return {
                "rule_status": "skipped",
                "test_passed": False,
                "reason": type(exc).__name__,
            }

    async def _generate_extraction_rule_impl(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Generate one selector with the configured model and test it on the fetched page."""
        if payload.get("enabled") is False:
            return {
                "rule_status": "skipped",
                "reason": "Supervisor rule generation is not configured for this task.",
            }
        page_url = payload.get("page_url")
        if not isinstance(page_url, str):
            for result in payload.get("dependencies", {}).values():
                if isinstance(result, dict) and isinstance(result.get("items"), list):
                    page_url = next(
                        (
                            item.get("url")
                            for item in result["items"]
                            if isinstance(item, dict) and isinstance(item.get("url"), str)
                        ),
                        None,
                    )
                    if page_url:
                        break
        if not isinstance(page_url, str):
            raise ValueError("generate_extraction_rule requires page_url or a discovered page")
        safe_url = validate_public_http_url(page_url)
        await asyncio.to_thread(
            ensure_robots_allowed,
            safe_url,
            settings.request_timeout_seconds,
        )
        page = await asyncio.to_thread(
            ScraplingAdapter.fetch_page,
            safe_url,
            settings.request_timeout_seconds,
        )
        final_url = validate_public_http_url(str(getattr(page, "url", None) or safe_url))
        if not is_same_origin(final_url, safe_url):
            raise ValueError("Extraction rule page redirected outside its seed origin.")
        body = getattr(page, "body", b"")
        html_sample = (
            bytes(body).decode("utf-8", errors="replace")
            if isinstance(body, (bytes, bytearray))
            else str(body or page.get_all_text(strip=True))
        )[:30_000]
        api_key = (
            settings.supervisor_api_key.get_secret_value()
            if settings.supervisor_api_key is not None
            else ""
        )
        planner = SupervisorClient(
            settings.supervisor_api_base,
            api_key,
            settings.supervisor_model,
            settings.supervisor_timeout_seconds,
            proxy=settings.egress_proxy_url,
        )
        goal = payload.get("goal", "Extract the primary movie, series or animation entries.")
        rule = await planner.generate_extraction_rule(str(goal), final_url, html_sample)
        extraction = await asyncio.to_thread(
            ScraplingAdapter.extract,
            page,
            rule.selector,
            rule.mode,
        )
        values = extraction.get("text", [])
        if not values:
            raise ValueError("Generated extraction rule returned no matches on the source page.")
        workflow_id = str(payload.get("_workflow_id") or "manual")
        rule_id = await asyncio.to_thread(
            self.rules.save_tested_rule,
            page_url=final_url,
            goal=str(goal),
            mode=rule.mode,
            selector=rule.selector,
            rationale=rule.rationale,
            match_count=len(values),
            sample_values=[str(value) for value in values[:5]],
            workflow_id=workflow_id,
        )
        return {
            "rule_id": rule_id,
            "rule_status": "tested",
            "page_url": final_url,
            "mode": rule.mode,
            "selector": rule.selector,
            "rationale": rule.rationale,
            "test_passed": True,
            "match_count": len(values),
            "sample_values": values[:5],
            "verification_level": "live_page_selector_test",
        }

    async def _register_candidates(self, payload: dict[str, Any]) -> dict[str, Any]:
        workflow_id = payload.get("_workflow_id")
        items = payload.get("items")
        if not isinstance(items, list):
            for result in payload.get("dependencies", {}).values():
                if isinstance(result, dict) and isinstance(result.get("items"), list):
                    items = result["items"]
                    break
        if not isinstance(workflow_id, str) or not isinstance(items, list):
            raise ValueError("register_candidates requires a workflow and crawl items")
        candidate_ids = await asyncio.to_thread(
            self.candidates.ingest_crawl_items, workflow_id, items
        )
        return {
            "candidate_ids": candidate_ids,
            "count": len(candidate_ids),
            "review_status": "pending_review",
        }

    async def _probe_local_media_file(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Probe only a file already staged inside MEDIA_PROBE_ROOT; never accept a URL."""
        local_path = payload.get("local_path")
        if not isinstance(local_path, str) or not local_path:
            raise ValueError("probe_local_media_file requires a staged local_path")
        timeout_seconds = payload.get("timeout_seconds", 20)
        if (
            not isinstance(timeout_seconds, int)
            or isinstance(timeout_seconds, bool)
            or not 1 <= timeout_seconds <= 60
        ):
            raise ValueError("timeout_seconds must be an integer from 1 to 60")
        report = await asyncio.to_thread(
            probe_media_file,
            local_path,
            timeout_seconds=timeout_seconds,
        )
        candidate_id = payload.get("candidate_id")
        if candidate_id is not None:
            if not isinstance(candidate_id, str) or not candidate_id:
                raise ValueError("candidate_id must be a non-empty string")
            saved = await asyncio.to_thread(
                self.candidates.save_quality_report,
                candidate_id,
                report,
            )
            if not saved:
                raise ValueError("Media probe candidate does not exist")
        return {
            "candidate_id": candidate_id,
            "status": "probed",
            "width": report["video"]["width"],
            "height": report["video"]["height"],
            "is_4k_bitstream": report["is_4k_bitstream"],
            "hdr_bitstream_claim": report["hdr_bitstream_claim"],
            "native_4k_verified": False,
            "verification_level": report["verification_level"],
            "report": report,
        }

    async def _probe_media_candidates(self, payload: dict[str, Any]) -> dict[str, Any]:
        workflow_id = str(payload.get("_workflow_id") or "manual")
        """Download bounded direct-media candidates and inspect them in the no-network sidecar."""
        candidate_ids = payload.get("candidate_ids")
        if not isinstance(candidate_ids, list):
            candidate_ids = []
            for result in payload.get("dependencies", {}).values():
                if isinstance(result, dict) and isinstance(result.get("candidate_ids"), list):
                    candidate_ids.extend(result["candidate_ids"])
        if not all(isinstance(item, str) and item for item in candidate_ids):
            raise ValueError("probe_media_candidates requires non-empty string candidate IDs")
        candidate_ids = list(dict.fromkeys(candidate_ids))
        if not candidate_ids:
            return {
                "count": 0,
                "reports": [],
                "skipped_count": 0,
                "downloaded_bytes": 0,
            }

        timeout_seconds = payload.get("timeout_seconds", 20)
        if (
            not isinstance(timeout_seconds, int)
            or isinstance(timeout_seconds, bool)
            or not 1 <= timeout_seconds <= 60
        ):
            raise ValueError("timeout_seconds must be an integer from 1 to 60")

        skipped_count = max(0, len(candidate_ids) - 200)
        candidate_ids = candidate_ids[:200]
        reports: list[dict[str, Any]] = []
        file_candidates: list[tuple[str, dict[str, Any]]] = []
        for candidate_id in candidate_ids:
            candidate = await asyncio.to_thread(
                self.candidates.get_candidate,
                candidate_id,
            )
            if candidate is None:
                reports.append({"candidate_id": candidate_id, "status": "not_found"})
            elif candidate.get("media_type") != "file":
                reports.append(
                    {
                        "candidate_id": candidate_id,
                        "status": "manifest_candidate",
                        "verification_level": "manifest_analysis_required",
                    }
                )
            else:
                file_candidates.append((candidate_id, candidate))

        max_file_candidates = payload.get("max_file_candidates", 20)
        max_download_bytes = payload.get("max_download_bytes", MAX_MEDIA_PROBE_BYTES_PER_CANDIDATE)
        if not isinstance(max_file_candidates, int) or not 1 <= max_file_candidates <= 20:
            raise ValueError("max_file_candidates must be from 1 to 20")
        if (
            not isinstance(max_download_bytes, int)
            or not 1 <= max_download_bytes <= MAX_MEDIA_PROBE_BYTES_PER_CANDIDATE
        ):
            raise ValueError("max_download_bytes must be from 1 byte to 64 MiB")
        skipped_count += max(0, len(file_candidates) - max_file_candidates)
        for candidate_id, _candidate in file_candidates[max_file_candidates:]:
            reports.append({"candidate_id": candidate_id, "status": "batch_limit_skipped"})

        workflow_input = payload.get("_workflow_input") or {}
        batch_id = workflow_input.get("batch_id") if isinstance(workflow_input, dict) else None
        attempt = int(payload.get("_attempt_count", 1))
        staging = Path(os.environ.get("MEDIA_PROBE_STAGING", "/tmp/libretv-media-probe"))
        remaining_budget = max_download_bytes
        downloaded_bytes = 0
        for candidate_id, candidate in file_candidates[:max_file_candidates]:
            staged_path: Path | None = None
            try:
                media_url = validate_public_http_url(candidate["media_url"])
                if remaining_budget <= 0:
                    reports.append(
                        {"candidate_id": candidate_id, "status": "download_budget_exhausted"}
                    )
                    continue
                download_cap = min(
                    MAX_MEDIA_FILE_BYTES,
                    MAX_MEDIA_PROBE_BYTES_PER_CANDIDATE,
                    remaining_budget,
                )
                reservation_id = f"{workflow_id}:{candidate_id}:{attempt}"
                if batch_id:
                    reserved = await asyncio.to_thread(
                        self.batches.reserve_media_probe_bytes,
                        str(batch_id),
                        reservation_id,
                        download_cap,
                    )
                    if not reserved:
                        reports.append(
                            {"candidate_id": candidate_id, "status": "batch_budget_exhausted"}
                        )
                        continue
                staged_path = await download_candidate_media(
                    media_url,
                    staging,
                    proxy=settings.egress_proxy_url,
                    max_bytes=download_cap,
                )
                file_size = staged_path.stat().st_size
                remaining_budget -= file_size
                if batch_id:
                    adjusted = await asyncio.to_thread(
                        self.batches.adjust_media_probe_reservation,
                        str(batch_id),
                        reservation_id,
                        file_size,
                    )
                    if not adjusted:
                        raise RuntimeError("Media probe budget reservation could not be finalized")
                downloaded_bytes += file_size
                report = await asyncio.to_thread(
                    probe_media_file,
                    staged_path,
                    timeout_seconds=timeout_seconds,
                )
                saved = await asyncio.to_thread(
                    self.candidates.save_quality_report,
                    candidate_id,
                    report,
                )
                reports.append(
                    {
                        "candidate_id": candidate_id,
                        "status": "probed" if saved else "not_found",
                        "width": report["video"]["width"],
                        "height": report["video"]["height"],
                        "is_4k_bitstream": report["is_4k_bitstream"],
                        "hdr_bitstream_claim": report["hdr_bitstream_claim"],
                        "native_4k_verified": False,
                        "verification_level": report["verification_level"],
                    }
                )
            except Exception as exc:
                logger.warning(
                    "Media candidate probe failed for %s: %s",
                    candidate_id,
                    type(exc).__name__,
                )
                reports.append(
                    {
                        "candidate_id": candidate_id,
                        "status": "failed",
                        "error": type(exc).__name__,
                    }
                )
            finally:
                if staged_path is not None:
                    staged_path.unlink(missing_ok=True)
        return {
            "count": len(reports),
            "reports": reports,
            "skipped_count": skipped_count,
            "downloaded_bytes": downloaded_bytes,
            "remaining_download_budget_bytes": remaining_budget,
        }

    async def _analyze_media_manifest(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        candidate_id = payload.get("candidate_id")
        manifest_text = payload.get("manifest_text")
        manifest_format = payload.get("format", "hls")
        if not isinstance(candidate_id, str) or not candidate_id:
            raise ValueError("analyze_media_manifest requires candidate_id")
        if not isinstance(manifest_text, str):
            raise ValueError("analyze_media_manifest requires manifest_text")
        if manifest_format == "hls":
            report = analyze_hls_manifest(manifest_text)
        elif manifest_format == "dash":
            report = analyze_mpd_manifest(manifest_text)
        else:
            raise ValueError("format must be 'hls' or 'dash'")
        saved = await asyncio.to_thread(
            self.candidates.save_quality_report,
            candidate_id,
            report,
        )
        if not saved:
            raise ValueError("Media analysis candidate does not exist")
        return {
            "candidate_id": candidate_id,
            "quality_label": report["quality_label"],
            "is_4k_claim": report["is_4k_claim"],
            "hdr_claim": report["hdr_claim"],
            "verification_level": report["verification_level"],
        }

    async def _inspect_hls_protection(
        self,
        root_url: str,
        root_manifest: str,
        *,
        max_variant_playlists: int = 20,
        max_depth: int = 2,
    ) -> dict[str, Any]:
        pending: list[tuple[str, str, int]] = [(root_url, root_manifest, 0)]
        visited = {root_url}
        methods: set[str] = set()
        incomplete = False

        while pending:
            page_url, manifest_text, depth = pending.pop(0)
            variants: list[str] = []
            expects_variant_uri = False
            for raw_line in manifest_text.splitlines():
                line = raw_line.strip()
                if line.startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
                    attributes = line.split(":", 1)[1] if ":" in line else ""
                    method_match = re.search(r"(?:^|,)METHOD=([^,]+)", attributes)
                    format_match = re.search(r"(?:^|,)KEYFORMAT=([^,]+)", attributes)
                    method = method_match.group(1).strip('"') if method_match else "UNKNOWN"
                    key_format = format_match.group(1).strip('"') if format_match else "identity"
                    if method != "NONE" or key_format != "identity":
                        methods.add(method if method != "NONE" else key_format)
                if line.startswith("#EXT-X-STREAM-INF:"):
                    expects_variant_uri = True
                    continue
                if line.startswith("#EXT-X-MEDIA:"):
                    attributes = line.split(":", 1)[1] if ":" in line else ""
                    uri_match = re.search(r'(?:^|,)URI="([^"]+)"', attributes)
                    if uri_match:
                        try:
                            media_url = validate_public_http_url(
                                urljoin(page_url, uri_match.group(1))
                            )
                        except ValueError:
                            incomplete = True
                        else:
                            if not is_same_origin(root_url, media_url):
                                incomplete = True
                            elif media_url not in visited:
                                variants.append(media_url)
                if expects_variant_uri and line and not line.startswith("#"):
                    expects_variant_uri = False
                    try:
                        variant_url = validate_public_http_url(urljoin(page_url, line))
                    except Exception:
                        incomplete = True
                        continue
                    if not is_same_origin(root_url, variant_url):
                        incomplete = True
                    elif variant_url not in visited:
                        variants.append(variant_url)

            if methods:
                return {
                    "protection_state": "protected_or_encrypted",
                    "protection_methods": sorted(methods),
                    "protection_check": "complete",
                }
            if variants and depth >= max_depth:
                incomplete = True
                continue
            for variant_url in variants:
                if variant_url in visited:
                    continue
                if len(visited) >= max_variant_playlists + 1:
                    incomplete = True
                    break
                visited.add(variant_url)
                try:
                    await asyncio.to_thread(
                        ensure_robots_allowed,
                        variant_url,
                        settings.request_timeout_seconds,
                    )
                    page = await asyncio.to_thread(
                        ScraplingAdapter.fetch_page,
                        variant_url,
                        settings.request_timeout_seconds,
                    )
                    if int(getattr(page, "status", 0)) >= 400:
                        incomplete = True
                        continue
                    final_url = str(getattr(page, "url", variant_url))
                    if not is_same_origin(root_url, final_url):
                        incomplete = True
                        continue
                    body = getattr(page, "body", b"")
                    text = (
                        bytes(body).decode("utf-8", errors="replace")
                        if isinstance(body, (bytes, bytearray))
                        else str(body)
                    )
                    pending.append((variant_url, text, depth + 1))
                except Exception:
                    incomplete = True

        if incomplete:
            return {
                "protection_state": "unknown",
                "protection_methods": [],
                "protection_check": "incomplete",
            }
        return {
            "protection_state": "none",
            "protection_methods": [],
            "protection_check": "complete",
        }

    async def _analyze_media_candidates(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        candidate_ids = payload.get("candidate_ids")
        if not isinstance(candidate_ids, list):
            candidate_ids = []
            for result in payload.get("dependencies", {}).values():
                if isinstance(result, dict) and isinstance(result.get("candidate_ids"), list):
                    candidate_ids.extend(result["candidate_ids"])
        if not isinstance(candidate_ids, list) or len(candidate_ids) > 20:
            raise ValueError("analyze_media_candidates accepts at most 20 candidate IDs")
        if not candidate_ids:
            return {"count": 0, "reports": []}

        reports: list[dict[str, Any]] = []
        for candidate_id in dict.fromkeys(candidate_ids):
            candidate = await asyncio.to_thread(self.candidates.get_candidate, str(candidate_id))
            if candidate is None:
                reports.append({"candidate_id": candidate_id, "status": "not_found"})
                continue
            media_type = candidate.get("media_type")
            if media_type not in {"hls", "dash"}:
                reports.append(
                    {
                        "candidate_id": candidate_id,
                        "status": "requires_file_probe",
                        "verification_level": "not_analyzed",
                    }
                )
                continue
            media_url = validate_public_http_url(candidate["media_url"])
            await asyncio.to_thread(
                ensure_robots_allowed,
                media_url,
                settings.request_timeout_seconds,
            )
            page = await asyncio.to_thread(
                ScraplingAdapter.fetch_page,
                media_url,
                settings.request_timeout_seconds,
            )
            body = getattr(page, "body", b"")
            if isinstance(body, (bytes, bytearray)):
                manifest_text = bytes(body).decode("utf-8", errors="replace")
            else:
                manifest_text = str(body)
            final_url = str(getattr(page, "url", media_url))
            if not is_same_origin(media_url, final_url):
                report = (
                    analyze_hls_manifest(manifest_text)
                    if media_type == "hls"
                    else analyze_mpd_manifest(manifest_text)
                )
                report["protection_state"] = "unknown"
                report["protection_check"] = "incomplete"
                report["protection_methods"] = report.get("protection_methods", [])
                saved = await asyncio.to_thread(
                    self.candidates.save_quality_report,
                    str(candidate_id),
                    report,
                )
                reports.append(
                    {
                        "candidate_id": candidate_id,
                        "status": "analyzed" if saved else "not_found",
                        "quality_label": report["quality_label"],
                        "is_4k_claim": report["is_4k_claim"],
                        "hdr_claim": report["hdr_claim"],
                        "max_height": report["max_height"],
                        "max_bitrate_bps": report["max_bitrate_bps"],
                        "verification_level": report["verification_level"],
                    }
                )
                continue
            report = (
                analyze_hls_manifest(manifest_text)
                if media_type == "hls"
                else analyze_mpd_manifest(manifest_text)
            )
            if media_type == "hls":
                report.update(await self._inspect_hls_protection(media_url, manifest_text))
            saved = await asyncio.to_thread(
                self.candidates.save_quality_report,
                str(candidate_id),
                report,
            )
            reports.append(
                {
                    "candidate_id": candidate_id,
                    "status": "analyzed" if saved else "not_found",
                    "quality_label": report["quality_label"],
                    "is_4k_claim": report["is_4k_claim"],
                    "hdr_claim": report["hdr_claim"],
                    "max_height": report["max_height"],
                    "max_bitrate_bps": report["max_bitrate_bps"],
                    "verification_level": report["verification_level"],
                }
            )
        return {"count": len(reports), "reports": reports}

    async def _heartbeat(
        self,
        workflow_id: str,
        node_id: str,
        fencing_token: int,
        stop: asyncio.Event,
        lost: asyncio.Event,
    ) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.lease_seconds / 3)
                return
            except TimeoutError:
                owned = await asyncio.to_thread(
                    self.store.heartbeat_node,
                    workflow_id,
                    node_id,
                    self.worker_id,
                    fencing_token,
                    self.lease_seconds,
                )
                if not owned:
                    lost.set()
                    return

    async def process_once(self) -> bool:
        node = await asyncio.to_thread(
            self.store.claim_ready_node, self.worker_id, self.lease_seconds
        )
        if node is None:
            return False

        workflow_id = node["workflow_id"]
        node_id = node["node_id"]
        fencing_token = int(node["lease_generation"])
        stop = asyncio.Event()
        lost = asyncio.Event()
        heartbeat = asyncio.create_task(
            self._heartbeat(workflow_id, node_id, fencing_token, stop, lost)
        )
        try:
            handler = self.handlers.get(node["node_type"])
            if handler is None:
                raise ValueError(f"Unsupported workflow node type: {node['node_type']}")
            payload = dict(node["input"])
            payload["dependencies"] = node.get("dependencies", {})
            payload["_workflow_id"] = workflow_id
            payload["_attempt_count"] = node["attempt_count"]
            payload["_workflow_input"] = node.get("workflow_input", {})
            payload["_resume_checkpoint"] = node.get("checkpoint") or {}

            async def save_checkpoint(snapshot: dict[str, Any]) -> None:
                saved = await asyncio.to_thread(
                    self.store.save_node_checkpoint,
                    workflow_id,
                    node_id,
                    self.worker_id,
                    fencing_token,
                    snapshot,
                )
                if not saved:
                    lost.set()

            payload["_save_checkpoint"] = save_checkpoint
            handler_task = asyncio.create_task(handler(payload))
            lost_task = asyncio.create_task(lost.wait())
            await asyncio.wait(
                {handler_task, lost_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if lost.is_set():
                logger.warning("Workflow lease lost for %s/%s", workflow_id, node_id)
                handler_task.cancel()
                await asyncio.gather(handler_task, return_exceptions=True)
                return True
            result = await handler_task
            completed = await asyncio.to_thread(
                self.store.complete_node,
                workflow_id,
                node_id,
                self.worker_id,
                fencing_token,
                result,
            )
            if not completed:
                logger.warning("Workflow completion fenced for %s/%s", workflow_id, node_id)
        except Exception as exc:
            logger.exception("Workflow node failed: %s/%s", workflow_id, node_id)
            if not lost.is_set():
                await asyncio.to_thread(
                    self.store.fail_node,
                    workflow_id,
                    node_id,
                    self.worker_id,
                    fencing_token,
                    f"{type(exc).__name__}: {str(exc)[:400]}",
                )
        finally:
            stop.set()
            await heartbeat
            if "lost_task" in locals():
                lost_task.cancel()
                await asyncio.gather(lost_task, return_exceptions=True)
        return True

    async def run_forever(self) -> None:
        self.store.initialize()
        self.candidates.initialize()
        self.rules.initialize()
        self.batches.initialize()
        logger.info("Workflow worker %s started", self.worker_id)
        while True:
            await asyncio.to_thread(self.store.reconcile_controls)
            processed = await self.process_once()
            if not processed:
                await asyncio.sleep(self.poll_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="LibreTV durable DAG workflow worker")
    parser.add_argument(
        "--worker-id",
        default=f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}",
    )
    parser.add_argument("--lease-seconds", type=int, default=60)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    args = parser.parse_args()
    if not settings.database_url:
        parser.error("DATABASE_URL is required for the workflow worker")
    logging.basicConfig(level=settings.log_level.upper())
    worker = WorkflowWorker(
        settings.database_url,
        args.worker_id,
        lease_seconds=args.lease_seconds,
        poll_seconds=args.poll_seconds,
    )
    asyncio.run(worker.run_forever())


if __name__ == "__main__":
    main()
