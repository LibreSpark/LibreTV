from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg.rows import dict_row

from app.security import UnsafeTargetError, validate_public_http_url


def _now() -> datetime:
    return datetime.now(UTC)


def _canonical_url(value: str) -> str:
    parts = urlsplit(value)
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", parts.query, "")
    )


class PostgresCandidateStore:
    """Evidence-backed resource candidates; deliberately has no publish operation."""

    def __init__(self, database_url: str) -> None:
        if not database_url.startswith(("postgres://", "postgresql://")):
            raise ValueError("DATABASE_URL must use PostgreSQL")
        self.database_url = database_url

    def initialize(self) -> None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_candidates (
                    candidate_id TEXT PRIMARY KEY,
                    source_url TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    media_url TEXT,
                    media_type TEXT,
                    quality_json JSONB,
                    status TEXT NOT NULL DEFAULT 'pending_review',
                    discovery_workflow_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                "ALTER TABLE resource_candidates ADD COLUMN IF NOT EXISTS quality_json JSONB"
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_candidate_evidence (
                    evidence_id BIGSERIAL PRIMARY KEY,
                    candidate_id TEXT NOT NULL REFERENCES resource_candidates(candidate_id)
                        ON DELETE CASCADE,
                    evidence_type TEXT NOT NULL,
                    evidence_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_resource_candidates_status_updated
                ON resource_candidates(status, updated_at DESC)
                """
            )
            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_candidate_evidence_candidate_id
                ON resource_candidate_evidence(candidate_id, evidence_id)
                """
            )
            db.execute(
                "ALTER TABLE resource_candidates ADD COLUMN IF NOT EXISTS playback_json JSONB"
            )
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_library (
                    resource_id TEXT PRIMARY KEY,
                    candidate_id TEXT NOT NULL UNIQUE REFERENCES resource_candidates(candidate_id),
                    title TEXT NOT NULL,
                    media_url TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    quality_json JSONB NOT NULL,
                    playback_json JSONB NOT NULL,
                    published_by TEXT NOT NULL,
                    published_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )

    def ingest_crawl_items(
        self,
        workflow_id: str,
        items: list[dict[str, Any]],
    ) -> list[str]:
        candidate_ids: list[str] = []
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            for item in items:
                page_url = item.get("url")
                if not isinstance(page_url, str):
                    continue
                try:
                    page_url = _canonical_url(validate_public_http_url(page_url))
                except UnsafeTargetError:
                    continue
                media_urls = item.get("media_urls")
                if not isinstance(media_urls, list):
                    media_urls = [item.get("media_url")]
                title = str(item.get("title") or page_url)[:300]
                for raw_media_url in media_urls[:20]:
                    if not isinstance(raw_media_url, str):
                        continue
                    try:
                        media_url = _canonical_url(validate_public_http_url(raw_media_url))
                    except UnsafeTargetError:
                        continue
                    candidate_id = hashlib.sha256(media_url.encode("utf-8")).hexdigest()[:24]
                    media_type = (
                        "hls"
                        if ".m3u8" in urlsplit(media_url).path.lower()
                        else "dash"
                        if ".mpd" in urlsplit(media_url).path.lower()
                        else "file"
                    )
                    row = db.execute(
                        """
                        INSERT INTO resource_candidates
                            (candidate_id, source_url, title, media_url, media_type,
                             status, discovery_workflow_id, created_at, updated_at)
                        VALUES (%s, %s, %s, %s, %s, 'pending_review', %s, %s, %s)
                        ON CONFLICT (source_url) DO UPDATE
                        SET title = CASE
                                WHEN resource_candidates.title = resource_candidates.source_url
                                THEN EXCLUDED.title ELSE resource_candidates.title END,
                            media_url = COALESCE(resource_candidates.media_url, EXCLUDED.media_url),
                            media_type = COALESCE(
                                resource_candidates.media_type, EXCLUDED.media_type
                            ),
                            updated_at = EXCLUDED.updated_at
                        RETURNING candidate_id
                        """,
                        (
                            candidate_id,
                            media_url,
                            title,
                            media_url,
                            media_type,
                            workflow_id,
                            now,
                            now,
                        ),
                    ).fetchone()
                    if row is None:
                        continue
                    stored_id = row["candidate_id"]
                    candidate_ids.append(stored_id)
                    evidence = {
                        "workflow_id": workflow_id,
                        "page_url": page_url,
                        "media_url": media_url,
                        "http_status": item.get("status"),
                        "title": item.get("title"),
                        "text_excerpt": str(item.get("text") or "")[:1500],
                        "media_type": media_type,
                        "rule_extractions": (
                            item.get("rule_extractions", [])[:20]
                            if isinstance(item.get("rule_extractions"), list)
                            else []
                        ),
                    }
                    db.execute(
                        """
                        INSERT INTO resource_candidate_evidence
                            (candidate_id, evidence_type, evidence_json, created_at)
                        VALUES (%s, 'scrapling_media_reference', %s::jsonb, %s)
                        """,
                        (
                            stored_id,
                            json.dumps(evidence, ensure_ascii=False),
                            now,
                        ),
                    )
        return candidate_ids

    def save_quality_report(
        self,
        candidate_id: str,
        report: dict[str, Any],
    ) -> bool:
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            cursor = db.execute(
                """
                UPDATE resource_candidates
                SET quality_json = %s::jsonb, updated_at = %s
                WHERE candidate_id = %s
                """,
                (json.dumps(report, ensure_ascii=False), now, candidate_id),
            )
            if cursor.rowcount != 1:
                return False
            db.execute(
                """
                INSERT INTO resource_candidate_evidence
                    (candidate_id, evidence_type, evidence_json, created_at)
                VALUES (%s, 'media_quality_analysis', %s::jsonb, %s)
                """,
                (
                    candidate_id,
                    json.dumps(report, ensure_ascii=False),
                    now,
                ),
            )
            return True

    @staticmethod
    def _validate_publication_evidence(
        candidate: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any], str]:
        quality = candidate.get("quality_json")
        playback = candidate.get("playback_json")
        if not isinstance(quality, dict):
            raise ValueError("A completed media quality report is required before approval.")
        if quality.get("protection_state") not in {"none", "none_detected"}:
            raise ValueError("Encrypted or DRM-protected media cannot be approved.")
        if not isinstance(playback, dict):
            raise ValueError("Real PlayerShell playback confirmation is required before approval.")
        progressed = playback.get("progressed_seconds")
        width = playback.get("decoded_width")
        height = playback.get("decoded_height")
        if (
            not isinstance(progressed, (int, float))
            or progressed < 2
            or not isinstance(width, int)
            or width <= 0
            or not isinstance(height, int)
            or height <= 0
        ):
            raise ValueError(
                "Playback evidence must include decoded frames and at least "
                "two seconds of progress."
            )
        media_type = candidate.get("media_type")
        if media_type == "hls":
            if quality.get("container") != "hls":
                raise ValueError("An HLS manifest quality report is required.")
            media_format = "hls"
        elif media_type == "file":
            decode_check = quality.get("decode_check")
            if not isinstance(decode_check, dict) or decode_check.get("status") != "passed":
                raise ValueError(
                    "Sample frame extraction and decode validation must pass before approval."
                )
            extension = urlsplit(str(candidate.get("media_url") or "")).path.lower().rsplit(".", 1)
            media_format = extension[-1] if len(extension) == 2 else ""
            if media_format not in {"mp4", "webm"}:
                raise ValueError(
                    "The current PlayerShell supports only MP4 and WebM file candidates."
                )
        else:
            raise ValueError(
                "This media format is not supported by the current LibreTV PlayerShell."
            )
        expected_playback_type = "hls" if media_format == "hls" else media_format
        if playback.get("media_type") != expected_playback_type:
            raise ValueError("Playback evidence does not match the candidate media format.")
        return quality, playback, media_format

    def record_playback_evidence(
        self,
        candidate_id: str,
        evidence: dict[str, Any],
    ) -> bool:
        media_type = evidence.get("media_type")
        observed = evidence.get("observed_seconds")
        progressed = evidence.get("progressed_seconds")
        width = evidence.get("decoded_width")
        height = evidence.get("decoded_height")
        if media_type not in {"hls", "mp4", "webm"}:
            raise ValueError("Unsupported playback media type.")
        if (
            not isinstance(observed, int)
            or observed < 1
            or not isinstance(progressed, (int, float))
            or progressed < 2
        ):
            raise ValueError("Playback evidence must show at least two seconds of progress.")
        if not isinstance(width, int) or width <= 0 or not isinstance(height, int) or height <= 0:
            raise ValueError("Playback evidence must include decoded video dimensions.")
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            candidate = db.execute(
                """
                SELECT media_type, media_url, status, quality_json
                FROM resource_candidates WHERE candidate_id = %s FOR UPDATE
                """,
                (candidate_id,),
            ).fetchone()
            if candidate is None or candidate["status"] != "pending_review":
                return False
            quality = candidate["quality_json"]
            if not isinstance(quality, dict):
                raise ValueError("A media quality report is required before playback approval.")
            if quality.get("protection_state") not in {"none", "none_detected"}:
                raise ValueError(
                    "Encrypted or DRM-protected media cannot be previewed or approved."
                )
            candidate_type = candidate["media_type"]
            expected = "hls" if candidate_type == "hls" else None
            if candidate_type == "file":
                path_parts = urlsplit(candidate["media_url"]).path.lower().rsplit(".", 1)
                expected = path_parts[-1] if len(path_parts) == 2 else None
            if expected is not None and media_type != expected:
                raise ValueError("Playback evidence does not match the candidate media format.")
            db.execute(
                "UPDATE resource_candidates SET playback_json = %s::jsonb, updated_at = %s "
                "WHERE candidate_id = %s AND status = 'pending_review'",
                (json.dumps(evidence, ensure_ascii=False), now, candidate_id),
            )
            db.execute(
                """
                INSERT INTO resource_candidate_evidence
                    (candidate_id, evidence_type, evidence_json, created_at)
                VALUES (%s, 'player_playback_confirmation', %s::jsonb, %s)
                """,
                (candidate_id, json.dumps(evidence, ensure_ascii=False), now),
            )
            return True

    def review_candidate(
        self,
        candidate_id: str,
        decision: str,
        reviewer_id: str,
        note: str = "",
    ) -> bool:
        if decision not in {"approved", "rejected"}:
            raise ValueError("Candidate decision must be approved or rejected")
        if not reviewer_id.strip():
            raise ValueError("A reviewer identity is required")
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            candidate = db.execute(
                "SELECT * FROM resource_candidates WHERE candidate_id = %s FOR UPDATE",
                (candidate_id,),
            ).fetchone()
            if candidate is None or candidate["status"] != "pending_review":
                return False
            candidate_data = dict(candidate)
            publication = None
            if decision == "approved":
                quality, playback, media_format = self._validate_publication_evidence(
                    candidate_data
                )
                if (
                    media_format == "file"
                    and quality.get("decode_check", {}).get("status") != "passed"
                ):
                    raise ValueError("File decode validation is required before publication.")
                publication = (quality, playback, media_format)
                db.execute(
                    """
                    INSERT INTO resource_library
                        (resource_id, candidate_id, title, media_url, media_type,
                         quality_json, playback_json, published_by, published_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
                    """,
                    (
                        candidate_id,
                        candidate_id,
                        candidate["title"],
                        candidate["media_url"],
                        media_format,
                        json.dumps(quality, ensure_ascii=False),
                        json.dumps(playback, ensure_ascii=False),
                        reviewer_id[:255],
                        now,
                        now,
                    ),
                )
            if publication is not None:
                db.execute(
                    """
                    INSERT INTO resource_candidate_evidence
                        (candidate_id, evidence_type, evidence_json, created_at)
                    VALUES (%s, 'formal_resource_publish', %s::jsonb, %s)
                    """,
                    (
                        candidate_id,
                        json.dumps(
                            {
                                "resource_id": candidate_id,
                                "media_format": publication[2],
                                "reviewer_sub": reviewer_id[:255],
                                "published_at": now.isoformat(),
                            },
                            ensure_ascii=False,
                        ),
                        now,
                    ),
                )
            db.execute(
                """
                UPDATE resource_candidates SET status = %s, updated_at = %s
                WHERE candidate_id = %s
                """,
                (decision, now, candidate_id),
            )
            evidence = {
                "decision": decision,
                "reviewer_id": reviewer_id[:255],
                "note": note[:1000],
                "reviewed_at": now.isoformat(),
                "published_resource_id": candidate_id if publication else None,
            }
            db.execute(
                """
                INSERT INTO resource_candidate_evidence
                    (candidate_id, evidence_type, evidence_json, created_at)
                VALUES (%s, 'human_review', %s::jsonb, %s)
                """,
                (candidate_id, json.dumps(evidence, ensure_ascii=False), now),
            )
            return True

    def list_formal_resources(self, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
        safe_limit = min(max(int(limit), 1), 100)
        pattern = f"%{query.strip()}%" if query.strip() else "%"
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            rows = db.execute(
                """
                SELECT library.*, candidate.source_url AS page_url
                FROM resource_library AS library
                JOIN resource_candidates AS candidate USING (candidate_id)
                WHERE library.title ILIKE %s OR library.media_url ILIKE %s
                ORDER BY library.updated_at DESC
                LIMIT %s
                """,
                (pattern, pattern, safe_limit),
            ).fetchall()
        resources = []
        for row in rows:
            media_format = row["media_type"]
            resources.append(
                {
                    "id": row["resource_id"],
                    "candidate_id": row["candidate_id"],
                    "title": row["title"],
                    "resource_type": "DIRECT_MEDIA",
                    "url": row["media_url"],
                    "media_format": media_format,
                    "access_state": "PUBLIC",
                    "validation_state": "VALIDATED",
                    "playback_state": "PLAYER_CONFIRMED",
                    "source_name": urlsplit(row["page_url"]).hostname or "Public source",
                    "updated_at": int(row["updated_at"].timestamp()),
                }
            )
        return resources

    def get_formal_resource(self, resource_id: str) -> dict[str, Any] | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            row = db.execute(
                """
                SELECT library.*, candidate.source_url AS page_url
                FROM resource_library AS library
                JOIN resource_candidates AS candidate USING (candidate_id)
                WHERE library.resource_id = %s
                """,
                (resource_id,),
            ).fetchone()
        if row is None:
            return None
        media_format = row["media_type"]
        return {
            "id": row["resource_id"],
            "candidate_id": row["candidate_id"],
            "title": row["title"],
            "resource_type": "DIRECT_MEDIA",
            "url": row["media_url"],
            "media_format": media_format,
            "access_state": "PUBLIC",
            "validation_state": "VALIDATED",
            "playback_state": "PLAYER_CONFIRMED",
            "source_name": urlsplit(row["page_url"]).hostname or "Public source",
            "updated_at": int(row["updated_at"].timestamp()),
        }

    def record_formal_resource_playback(
        self,
        resource_id: str,
        evidence: dict[str, Any],
    ) -> bool:
        now = _now()
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            resource = db.execute(
                "SELECT candidate_id FROM resource_library WHERE resource_id = %s FOR UPDATE",
                (resource_id,),
            ).fetchone()
            if resource is None:
                return False
            db.execute(
                """
                INSERT INTO resource_candidate_evidence
                    (candidate_id, evidence_type, evidence_json, created_at)
                VALUES (%s, 'formal_resource_playback', %s::jsonb, %s)
                """,
                (resource["candidate_id"], json.dumps(evidence, ensure_ascii=False), now),
            )
            return True

    def list_candidates(
        self,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        safe_limit = min(max(limit, 1), 200)
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            if status:
                rows = db.execute(
                    """
                    SELECT * FROM resource_candidates
                    WHERE status = %s ORDER BY updated_at DESC LIMIT %s
                    """,
                    (status, safe_limit),
                ).fetchall()
            else:
                rows = db.execute(
                    "SELECT * FROM resource_candidates ORDER BY updated_at DESC LIMIT %s",
                    (safe_limit,),
                ).fetchall()
        return [dict(row) for row in rows]

    def get_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        with psycopg.connect(self.database_url, row_factory=dict_row) as db:
            candidate = db.execute(
                "SELECT * FROM resource_candidates WHERE candidate_id = %s",
                (candidate_id,),
            ).fetchone()
            if candidate is None:
                return None
            evidence = db.execute(
                """
                SELECT evidence_id, evidence_type, evidence_json, created_at
                FROM resource_candidate_evidence
                WHERE candidate_id = %s ORDER BY evidence_id
                """,
                (candidate_id,),
            ).fetchall()
        result = dict(candidate)
        result["evidence"] = [
            {
                "evidence_id": row["evidence_id"],
                "type": row["evidence_type"],
                "data": row["evidence_json"],
                "created_at": row["created_at"],
            }
            for row in evidence
        ]
        return result
