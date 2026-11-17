from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

from app.security import validate_public_http_url

MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_REDIRECTS = 5
REDIRECT_STATUSES = {301, 302, 303, 307, 308}


class MediaDownloadError(ValueError):
    """A media candidate could not be safely staged for offline probing."""


async def download_candidate_media(
    url: str,
    staging_dir: str | Path,
    *,
    proxy: str | None,
    timeout_seconds: float = 60.0,
    max_bytes: int = MAX_MEDIA_FILE_BYTES,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Path:
    """Stream one public media URL to a private local file; never pass URLs to ffprobe."""
    if not 1 <= max_bytes <= MAX_MEDIA_FILE_BYTES:
        raise MediaDownloadError("Media download limit must be between 1 byte and 2 GiB")
    if not 1 <= timeout_seconds <= 300:
        raise MediaDownloadError("Media download timeout must be between 1 and 300 seconds")
    if transport is None and not proxy:
        raise MediaDownloadError("A configured egress proxy is required for media downloads")

    current_url = await asyncio.to_thread(validate_public_http_url, url)
    initial_scheme = urlsplit(current_url).scheme.lower()
    staging = Path(staging_dir)
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    if staging.is_symlink() or not staging.is_dir():
        raise MediaDownloadError("Media staging path must be a real directory")

    descriptor, raw_path = tempfile.mkstemp(prefix=".libretv-probe-", suffix=".media", dir=staging)
    path = Path(raw_path)
    total = 0
    completed = False
    try:
        timeout = httpx.Timeout(
            connect=15.0,
            read=timeout_seconds,
            write=15.0,
            pool=15.0,
        )
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
            proxy=proxy,
            transport=transport,
            headers={"User-Agent": "LibreTV-Scrapling-Engine/0.1"},
        ) as client:
            for redirect_count in range(MAX_REDIRECTS + 1):
                async with client.stream("GET", current_url) as response:
                    if response.status_code in REDIRECT_STATUSES:
                        location = response.headers.get("location")
                        if not location or redirect_count >= MAX_REDIRECTS:
                            raise MediaDownloadError("Media URL exceeded the redirect limit")
                        next_url = await asyncio.to_thread(
                            validate_public_http_url,
                            urljoin(current_url, location),
                        )
                        next_scheme = urlsplit(next_url).scheme.lower()
                        if initial_scheme == "https" and next_scheme != "https":
                            raise MediaDownloadError(
                                "HTTPS media redirects cannot downgrade to HTTP"
                            )
                        current_url = next_url
                        continue

                    if response.status_code != 200:
                        raise MediaDownloadError(
                            f"Media server returned HTTP {response.status_code}"
                        )
                    content_type = (
                        response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    )
                    if content_type in {
                        "text/html",
                        "application/json",
                        "text/xml",
                        "application/xml",
                    }:
                        raise MediaDownloadError("Media URL returned a document, not a media file")
                    content_length = response.headers.get("content-length")
                    if (
                        content_length
                        and content_length.isdigit()
                        and int(content_length) > max_bytes
                    ):
                        raise MediaDownloadError("Media file exceeds the configured download limit")

                    with os.fdopen(descriptor, "wb") as handle:
                        descriptor = -1
                        async for chunk in response.aiter_bytes(64 * 1024):
                            total += len(chunk)
                            if total > max_bytes:
                                raise MediaDownloadError(
                                    "Media file exceeds the configured download limit"
                                )
                            handle.write(chunk)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if total <= 0:
                        raise MediaDownloadError("Media server returned an empty file")
                    completed = True
                    return path

        raise MediaDownloadError("Media redirect chain did not produce a file")
    except (httpx.HTTPError, OSError) as exc:
        raise MediaDownloadError(f"Media download failed: {type(exc).__name__}") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        # On success the caller owns the returned file and removes it after probing.
        if not completed:
            path.unlink(missing_ok=True)
