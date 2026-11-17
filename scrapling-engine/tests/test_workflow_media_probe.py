from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from app.workflow_worker import WorkflowWorker


class _CandidateStore:
    def __init__(self, candidates: dict[str, dict[str, Any]]) -> None:
        self.candidates = candidates
        self.saved: list[tuple[str, dict[str, Any]]] = []

    def get_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        return self.candidates.get(candidate_id)

    def save_quality_report(self, candidate_id: str, report: dict[str, Any]) -> bool:
        self.saved.append((candidate_id, report))
        return True


def test_probe_media_candidates_downloads_and_probes_direct_file_candidate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    worker = WorkflowWorker.__new__(WorkflowWorker)
    worker.candidates = _CandidateStore(
        {
            "file-1": {
                "candidate_id": "file-1",
                "media_type": "file",
                "media_url": "https://93.184.216.34/video.mp4",
            }
        }
    )
    staged = tmp_path / "download.media"
    staged.write_bytes(b"media")

    async def fake_download(url, staging, *, proxy, max_bytes):
        assert url == "https://93.184.216.34/video.mp4"
        assert Path(staging) == tmp_path
        assert max_bytes > 0
        return staged

    def fake_probe(path, *, timeout_seconds):
        assert path == staged
        assert timeout_seconds == 20
        return {
            "video": {"width": 3840, "height": 2160},
            "is_4k_bitstream": True,
            "hdr_bitstream_claim": True,
            "native_4k_verified": False,
            "verification_level": "local_bitstream_probe",
        }

    monkeypatch.setenv("MEDIA_PROBE_STAGING", str(tmp_path))
    monkeypatch.setattr("app.workflow_worker.download_candidate_media", fake_download)
    monkeypatch.setattr("app.workflow_worker.probe_media_file", fake_probe)

    result = asyncio.run(
        worker._probe_media_candidates(
            {"dependencies": {"register": {"candidate_ids": ["file-1"]}}}
        )
    )

    assert result["count"] == 1
    assert result["reports"][0] == {
        "candidate_id": "file-1",
        "status": "probed",
        "width": 3840,
        "height": 2160,
        "is_4k_bitstream": True,
        "hdr_bitstream_claim": True,
        "native_4k_verified": False,
        "verification_level": "local_bitstream_probe",
    }
    assert len(worker.candidates.saved) == 1
    assert not staged.exists()


def test_probe_media_candidates_keeps_manifest_candidates_on_manifest_path() -> None:
    worker = WorkflowWorker.__new__(WorkflowWorker)
    worker.candidates = _CandidateStore(
        {
            "hls-1": {
                "candidate_id": "hls-1",
                "media_type": "hls",
                "media_url": "https://93.184.216.34/master.m3u8",
            }
        }
    )

    result = asyncio.run(worker._probe_media_candidates({"candidate_ids": ["hls-1"]}))

    assert result["reports"] == [
        {
            "candidate_id": "hls-1",
            "status": "manifest_candidate",
            "verification_level": "manifest_analysis_required",
        }
    ]
    assert worker.candidates.saved == []


def test_probe_media_candidates_prioritizes_files_after_manifest_candidates(
    tmp_path: Path,
    monkeypatch,
) -> None:
    worker = WorkflowWorker.__new__(WorkflowWorker)
    candidate_ids = [f"manifest-{index}" for index in range(20)] + ["direct-file"]
    worker.candidates = _CandidateStore(
        {
            **{
                candidate_id: {
                    "candidate_id": candidate_id,
                    "media_type": "hls",
                    "media_url": "https://93.184.216.34/master.m3u8",
                }
                for candidate_id in candidate_ids[:20]
            },
            "direct-file": {
                "candidate_id": "direct-file",
                "media_type": "file",
                "media_url": "https://93.184.216.34/video.mp4",
            },
        }
    )
    staged = tmp_path / "direct-file.media"
    staged.write_bytes(b"media")

    async def fake_download(url, staging, *, proxy, max_bytes):
        assert url == "https://93.184.216.34/video.mp4"
        assert Path(staging) == tmp_path
        assert max_bytes > 0
        return staged

    def fake_probe(path, *, timeout_seconds):
        assert path == staged
        return {
            "video": {"width": 1920, "height": 1080},
            "is_4k_bitstream": False,
            "hdr_bitstream_claim": False,
            "verification_level": "local_bitstream_probe",
        }

    monkeypatch.setenv("MEDIA_PROBE_STAGING", str(tmp_path))
    monkeypatch.setattr("app.workflow_worker.download_candidate_media", fake_download)
    monkeypatch.setattr("app.workflow_worker.probe_media_file", fake_probe)

    result = asyncio.run(worker._probe_media_candidates({"candidate_ids": candidate_ids}))

    assert result["skipped_count"] == 0
    assert any(
        item["candidate_id"] == "direct-file" and item["status"] == "probed"
        for item in result["reports"]
    )
    assert sum(item["status"] == "manifest_candidate" for item in result["reports"]) == 20
    assert not staged.exists()


def test_probe_media_candidates_reports_overflow_after_twenty_file_candidates(
    monkeypatch,
) -> None:
    worker = WorkflowWorker.__new__(WorkflowWorker)
    candidate_ids = [f"file-{index}" for index in range(21)]
    worker.candidates = _CandidateStore(
        {
            candidate_id: {
                "candidate_id": candidate_id,
                "media_type": "file",
                "media_url": "https://93.184.216.34/video.mp4",
            }
            for candidate_id in candidate_ids
        }
    )

    async def unavailable_download(*_args, **_kwargs):
        raise OSError("fixture download unavailable")

    monkeypatch.setattr(
        "app.workflow_worker.download_candidate_media",
        unavailable_download,
    )
    result = asyncio.run(worker._probe_media_candidates({"candidate_ids": candidate_ids}))

    assert result["count"] == 21
    assert result["skipped_count"] == 1
    assert sum(item["status"] == "failed" for item in result["reports"]) == 20
    assert sum(item["status"] == "batch_limit_skipped" for item in result["reports"]) == 1
