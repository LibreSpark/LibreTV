from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from app.ffprobe_analyzer import MediaProbeError, analyze_local_media_file

logger = logging.getLogger("libretv.media_probe_worker")
_JOB_ID = re.compile(r"^[0-9a-f]{32}$")
POLL_SECONDS = 0.25
MAX_REQUEST_BYTES = 4096


def _directories() -> tuple[Path, Path, Path]:
    staging = Path(os.environ.get("MEDIA_PROBE_STAGING", "/probe/staging"))
    inbox = Path(os.environ.get("MEDIA_PROBE_INBOX", "/probe/inbox"))
    outbox = Path(os.environ.get("MEDIA_PROBE_OUTBOX", "/probe/outbox"))
    if staging.is_symlink() or not staging.is_dir():
        raise RuntimeError("Probe staging mount must be a read-only directory")
    for directory in (inbox, outbox):
        if directory.is_symlink():
            raise RuntimeError("Probe spool directories cannot be symbolic links")
        if not directory.exists():
            directory.mkdir(parents=True, exist_ok=True)
        if not directory.is_dir():
            raise RuntimeError("Probe spool paths must be directories")
    return staging, inbox, outbox


def _write_result(outbox: Path, job_id: str, result: dict[str, Any]) -> None:
    destination = outbox / f"{job_id}.json"
    temporary = outbox / f".{job_id}.tmp"
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, destination)


def process_request(
    request_path: Path,
    inbox: Path,
    outbox: Path,
    staging: Path | None = None,
) -> bool:
    if request_path.is_symlink() or not request_path.is_file():
        return False
    if request_path.stat().st_size > MAX_REQUEST_BYTES:
        return False
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        job_id = request.get("job_id")
        filename = request.get("filename")
        timeout_seconds = request.get("timeout_seconds", 20)
        if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            return False
        if filename != f"{job_id}.media":
            return False
        if (
            not isinstance(timeout_seconds, int)
            or isinstance(timeout_seconds, bool)
            or not 1 <= timeout_seconds <= 60
        ):
            raise ValueError("Invalid probe timeout")
        destination = outbox / f"{job_id}.json"
        if destination.exists():
            return True
        staging_root = staging or Path(os.environ.get("MEDIA_PROBE_STAGING", "/probe/staging"))
        media_path = staging_root / filename
        if media_path.is_symlink() or not media_path.is_file():
            raise MediaProbeError("Probe input is missing or is not a regular file")
        report = analyze_local_media_file(
            media_path,
            timeout_seconds=timeout_seconds,
        )
        _write_result(outbox, job_id, {"ok": True, "report": report})
    except Exception as exc:
        logger.warning("Media probe request failed: %s", type(exc).__name__)
        if isinstance(locals().get("job_id"), str) and _JOB_ID.fullmatch(job_id):
            try:
                _write_result(
                    outbox,
                    job_id,
                    {"ok": False, "error": type(exc).__name__, "message": str(exc)[:300]},
                )
            except FileExistsError:
                pass
    return True


def cleanup_orphaned_results(
    inbox: Path,
    outbox: Path,
    *,
    now: float | None = None,
    retention_seconds: int = 60,
) -> int:
    """Reap acknowledged sidecar outputs without granting the caller write access."""
    current_time = time.time() if now is None else now
    removed = 0
    for result_path in outbox.glob("*.json"):
        job_id = result_path.stem
        if not _JOB_ID.fullmatch(job_id):
            continue
        if result_path.is_symlink():
            result_path.unlink(missing_ok=True)
            removed += 1
            continue
        request_path = inbox / f"{job_id}.json"
        if request_path.is_file() and not request_path.is_symlink():
            continue
        try:
            age = current_time - result_path.stat().st_mtime
        except OSError:
            continue
        if age >= retention_seconds:
            result_path.unlink(missing_ok=True)
            removed += 1
    return removed


def run_forever() -> None:
    staging, inbox, outbox = _directories()
    logger.info("Isolated media probe worker started (network disabled by container)")
    while True:
        for request_path in sorted(inbox.glob("*.json")):
            try:
                process_request(request_path, inbox, outbox, staging)
            except Exception:
                logger.exception("Unexpected media probe worker failure")
        cleanup_orphaned_results(inbox, outbox)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    run_forever()
