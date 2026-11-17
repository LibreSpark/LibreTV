from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from app.media_downloader import MediaDownloadError, download_candidate_media


@pytest.mark.asyncio
async def test_download_streams_public_media_to_private_staging_file(tmp_path: Path) -> None:
    payload = b"media-payload" * 100

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "93.184.216.34"
        return httpx.Response(
            200,
            headers={"content-type": "video/mp4", "content-length": str(len(payload))},
            content=payload,
        )

    path = await download_candidate_media(
        "https://93.184.216.34/video.mp4",
        tmp_path,
        proxy=None,
        transport=httpx.MockTransport(handler),
    )
    try:
        assert path.parent == tmp_path
        assert path.read_bytes() == payload
        assert path.stat().st_mode & 0o777 == 0o600
    finally:
        path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_download_revalidates_redirect_and_rejects_metadata_ip(tmp_path: Path) -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(
            302,
            headers={"location": "http://169.254.169.254/latest/meta-data/"},
        )

    with pytest.raises(ValueError):
        await download_candidate_media(
            "https://93.184.216.34/video.mp4",
            tmp_path,
            proxy=None,
            transport=httpx.MockTransport(handler),
        )
    assert len(requests) == 1
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_download_rejects_https_downgrade(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": "http://93.184.216.34/video.mp4"},
        )

    with pytest.raises(MediaDownloadError, match="downgrade"):
        await download_candidate_media(
            "https://93.184.216.34/video.mp4",
            tmp_path,
            proxy=None,
            transport=httpx.MockTransport(handler),
        )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_download_enforces_streaming_size_limit_and_removes_partial_file(
    tmp_path: Path,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "video/mp4"},
            content=b"0123456789",
        )

    with pytest.raises(MediaDownloadError, match="download limit"):
        await download_candidate_media(
            "https://93.184.216.34/video.mp4",
            tmp_path,
            proxy=None,
            max_bytes=4,
            transport=httpx.MockTransport(handler),
        )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_download_rejects_html_document(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<html/>")

    with pytest.raises(MediaDownloadError, match="document"):
        await download_candidate_media(
            "https://93.184.216.34/video.mp4",
            tmp_path,
            proxy=None,
            transport=httpx.MockTransport(handler),
        )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_live_media_download_requires_egress_proxy(tmp_path: Path) -> None:
    with pytest.raises(MediaDownloadError, match="egress proxy is required"):
        await download_candidate_media(
            "https://93.184.216.34/video.mp4",
            tmp_path,
            proxy=None,
        )
    assert list(tmp_path.iterdir()) == []
