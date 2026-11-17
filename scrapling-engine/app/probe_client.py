from __future__ import annotations

import json
import os
import shutil
import stat
import time
import uuid
from pathlib import Path
from typing import Any

MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024 * 1024


class MediaProbeError(ValueError):
    """The isolated media probe did not return a valid report."""


def probe_media_file(
    local_path: str | Path,
    *,
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    if not 1 <= timeout_seconds <= 60:
        raise MediaProbeError("Probe timeout must be between 1 and 60 seconds")
    source = Path(local_path)
    if source.is_symlink():
        raise MediaProbeError("Symbolic links are not accepted for media probing")
    try:
        probe_root = Path(os.environ.get("MEDIA_PROBE_ROOT", "/tmp/libretv-media-probe"))
        probe_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        probe_root = probe_root.resolve(strict=True)
        resolved = source.resolve(strict=True)
        resolved.relative_to(probe_root)
        metadata = resolved.stat()
    except (OSError, ValueError) as exc:
        raise MediaProbeError("Media file must exist inside MEDIA_PROBE_ROOT") from exc
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0:
        raise MediaProbeError("Only non-empty regular media files can be probed")
    if metadata.st_size > MAX_MEDIA_FILE_BYTES:
        raise MediaProbeError("Media file exceeds the 2 GiB probe limit")

    staging = Path(os.environ.get("MEDIA_PROBE_STAGING", "/probe/staging"))
    inbox = Path(os.environ.get("MEDIA_PROBE_INBOX", "/probe/inbox"))
    outbox = Path(os.environ.get("MEDIA_PROBE_OUTBOX", "/probe/outbox"))
    if not staging.is_dir() or not inbox.is_dir() or not outbox.is_dir():
        raise MediaProbeError("Isolated media probe sidecar is not mounted")
    job_id = uuid.uuid4().hex
    media_path = staging / f"{job_id}.media"
    request_path = inbox / f"{job_id}.json"
    request_tmp = inbox / f".{job_id}.request.tmp"
    result_path = outbox / f"{job_id}.json"

    try:
        # The sidecar sees this staging volume read-only; publish the request last.
        shutil.copyfile(resolved, media_path)
        request = {
            "job_id": job_id,
            "filename": media_path.name,
            "timeout_seconds": timeout_seconds,
        }
        request_tmp.write_text(
            json.dumps(request, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(request_tmp, request_path)

        deadline = time.monotonic() + timeout_seconds + 20
        while time.monotonic() < deadline:
            if result_path.is_file() and not result_path.is_symlink():
                if result_path.stat().st_size > 2 * 1024 * 1024:
                    raise MediaProbeError("Probe sidecar response exceeds the 2 MiB limit")
                try:
                    payload = json.loads(result_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise MediaProbeError("Probe sidecar returned an invalid response") from exc
                if not isinstance(payload, dict) or not isinstance(payload.get("ok"), bool):
                    raise MediaProbeError("Probe sidecar returned an invalid response")
                if not payload["ok"]:
                    message = payload.get("message")
                    raise MediaProbeError(
                        str(message)[:300] if isinstance(message, str) else "Media probe failed"
                    )
                report = payload.get("report")
                if not isinstance(report, dict) or not isinstance(report.get("video"), dict):
                    raise MediaProbeError("Probe sidecar returned an incomplete report")
                return report
            time.sleep(0.2)
        raise MediaProbeError("Timed out waiting for isolated media probe sidecar")
    finally:
        # The result volume is mounted read-only in this worker; the sidecar
        # reaps acknowledged results after the request disappears.
        for path in (request_tmp, request_path, media_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
