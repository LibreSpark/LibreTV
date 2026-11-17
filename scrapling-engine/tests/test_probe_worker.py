from __future__ import annotations

import json
import os

from app import probe_worker
from app.probe_worker import cleanup_orphaned_results


def test_probe_worker_processes_request_without_database_or_network_client(
    tmp_path,
    monkeypatch,
):
    staging = tmp_path / "staging"
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    staging.mkdir()
    inbox.mkdir()
    outbox.mkdir()
    job_id = "a" * 32
    media = staging / f"{job_id}.media"
    media.write_bytes(b"media")
    request = inbox / f"{job_id}.json"
    request.write_text(
        json.dumps(
            {
                "job_id": job_id,
                "filename": media.name,
                "timeout_seconds": 5,
            }
        ),
        encoding="utf-8",
    )
    expected = {
        "video": {"width": 1920, "height": 1080},
        "is_4k_bitstream": False,
        "hdr_bitstream_claim": False,
        "native_4k_verified": False,
        "verification_level": "local_bitstream_probe",
    }
    monkeypatch.setattr(
        probe_worker,
        "analyze_local_media_file",
        lambda path, timeout_seconds: expected,
    )

    assert probe_worker.process_request(request, inbox, outbox, staging) is True
    result = json.loads((outbox / f"{job_id}.json").read_text())
    assert result == {"ok": True, "report": expected}


def test_probe_worker_rejects_path_traversal_filename(tmp_path, monkeypatch):
    staging = tmp_path / "staging"
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    staging.mkdir()
    inbox.mkdir()
    outbox.mkdir()
    job_id = "b" * 32
    request = inbox / f"{job_id}.json"
    request.write_text(
        json.dumps(
            {
                "job_id": job_id,
                "filename": "../../etc/passwd",
                "timeout_seconds": 5,
            }
        ),
        encoding="utf-8",
    )
    called = False

    def unexpected_probe(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("unsafe path must not reach ffprobe")

    monkeypatch.setattr(probe_worker, "analyze_local_media_file", unexpected_probe)
    assert probe_worker.process_request(request, inbox, outbox, staging) is False
    assert called is False
    assert list(outbox.iterdir()) == []


def test_cleanup_orphaned_results_reaps_acknowledged_output_only_after_retention(
    tmp_path,
):
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    inbox.mkdir()
    outbox.mkdir()

    orphan_id = "c" * 32
    active_id = "d" * 32
    young_id = "e" * 32
    orphan = outbox / f"{orphan_id}.json"
    active = outbox / f"{active_id}.json"
    young = outbox / f"{young_id}.json"
    orphan.write_text('{"ok":true}', encoding="utf-8")
    active.write_text('{"ok":true}', encoding="utf-8")
    young.write_text('{"ok":true}', encoding="utf-8")
    (inbox / f"{active_id}.json").write_text("{}", encoding="utf-8")

    now = 10_000.0
    old_time = now - 61
    os.utime(orphan, (old_time, old_time))
    os.utime(active, (old_time, old_time))
    os.utime(young, (now - 5, now - 5))

    assert cleanup_orphaned_results(inbox, outbox, now=now) == 1
    assert not orphan.exists()
    assert active.exists()
    assert young.exists()


def test_cleanup_orphaned_results_ignores_unrelated_filenames(tmp_path):
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    inbox.mkdir()
    outbox.mkdir()
    unrelated = outbox / "not-a-job.json"
    unrelated.write_text("{}", encoding="utf-8")

    assert cleanup_orphaned_results(inbox, outbox, now=1000) == 0
    assert unrelated.exists()
