from __future__ import annotations

import json
import time

import pytest

from app.probe_client import MediaProbeError, probe_media_file
from app.probe_worker import cleanup_orphaned_results


def _report() -> dict:
    return {
        "video": {"width": 3840, "height": 2160},
        "is_4k_bitstream": True,
        "hdr_bitstream_claim": False,
        "native_4k_verified": False,
        "verification_level": "local_bitstream_probe",
    }


def test_probe_client_submits_file_and_reads_sidecar_result(tmp_path, monkeypatch):
    root = tmp_path / "staging"
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    root.mkdir()
    inbox.mkdir()
    outbox.mkdir()
    media = root / "clip.mp4"
    media.write_bytes(b"test media")
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    monkeypatch.setenv("MEDIA_PROBE_STAGING", str(root))
    monkeypatch.setenv("MEDIA_PROBE_INBOX", str(inbox))
    monkeypatch.setenv("MEDIA_PROBE_OUTBOX", str(outbox))

    def sidecar_tick(_seconds):
        request_files = list(inbox.glob("*.json"))
        assert len(request_files) == 1
        request = json.loads(request_files[0].read_text())
        assert (root / request["filename"]).read_bytes() == b"test media"
        (outbox / f"{request['job_id']}.json").write_text(
            json.dumps({"ok": True, "report": _report()}),
            encoding="utf-8",
        )

    monkeypatch.setattr("app.probe_client.time.sleep", sidecar_tick)
    report = probe_media_file(media, timeout_seconds=5)
    assert report["video"]["width"] == 3840
    assert list(inbox.iterdir()) == []
    assert len(list(outbox.iterdir())) == 1
    cleanup_orphaned_results(inbox, outbox, now=time.time() + 61)
    assert list(outbox.iterdir()) == []


def test_probe_client_rejects_path_outside_staging_root(tmp_path, monkeypatch):
    root = tmp_path / "staging"
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    root.mkdir()
    inbox.mkdir()
    outbox.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"test media")
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    monkeypatch.setenv("MEDIA_PROBE_INBOX", str(inbox))
    monkeypatch.setenv("MEDIA_PROBE_OUTBOX", str(outbox))
    with pytest.raises(MediaProbeError, match="inside MEDIA_PROBE_ROOT"):
        probe_media_file(outside)
    assert list(inbox.iterdir()) == []


def test_probe_client_rejects_symlink(tmp_path, monkeypatch):
    root = tmp_path / "staging"
    inbox = tmp_path / "inbox"
    outbox = tmp_path / "outbox"
    root.mkdir()
    inbox.mkdir()
    outbox.mkdir()
    media = root / "clip.mp4"
    media.write_bytes(b"test media")
    link = root / "linked.mp4"
    link.symlink_to(media)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    monkeypatch.setenv("MEDIA_PROBE_INBOX", str(inbox))
    monkeypatch.setenv("MEDIA_PROBE_OUTBOX", str(outbox))
    with pytest.raises(MediaProbeError, match="Symbolic links"):
        probe_media_file(link)
