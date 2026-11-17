from __future__ import annotations

import json
import subprocess
import sys

import pytest

from app.ffprobe_analyzer import (
    MediaProbeError,
    analyze_local_media_file,
)


def _media_file(tmp_path):
    root = tmp_path / "probe"
    root.mkdir()
    media = root / "sample.mp4"
    media.write_bytes(b"fake-media")
    return root, media


def test_probe_reports_encoded_dimensions_but_not_native_4k(tmp_path, monkeypatch):
    root, media = _media_file(tmp_path)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    payload = {
        "format": {
            "format_name": "mov,mp4",
            "duration": "120.5",
            "size": "1024",
            "bit_rate": "9000000",
        },
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": "hevc",
                "profile": "Main 10",
                "width": 3840,
                "height": 2160,
                "pix_fmt": "yuv420p10le",
                "avg_frame_rate": "60000/1001",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_space": "bt2020nc",
                "bit_rate": "8000000",
                "side_data_list": [
                    {
                        "side_data_type": "DOVI configuration record",
                        "dv_profile": 8,
                        "dv_level": 6,
                        "rpu_present": 1,
                        "el_present": 0,
                        "bl_present": 1,
                    },
                    {"side_data_type": "Mastering display metadata"},
                ],
            },
            {
                "index": 1,
                "codec_type": "audio",
                "codec_name": "eac3",
                "profile": "Dolby Digital Plus",
                "channels": 6,
                "channel_layout": "5.1",
                "sample_rate": "48000",
                "tags": {"language": "zh", "title": "国语"},
                "disposition": {"default": 1, "forced": 0},
            },
            {
                "index": 2,
                "codec_type": "subtitle",
                "codec_name": "ass",
                "tags": {"language": "en", "title": "English"},
                "disposition": {"default": 0, "forced": 0},
            },
        ],
    }

    real_popen = subprocess.Popen

    def fake_popen(command, **kwargs):
        assert command[0] == "prlimit"
        assert command[command.index("--") + 1] == "taskset"
        assert command[command.index("taskset") + 1] == "-c"
        ffprobe_args = command[command.index("ffprobe") :]
        whitelist_index = ffprobe_args.index("-protocol_whitelist")
        assert ffprobe_args[whitelist_index + 1] == "file"
        entries = command[command.index("-show_entries") + 1]
        assert "stream_tags=language,title" in entries
        assert "stream_disposition=default,forced" in entries
        assert command[-1] == str(media)
        assert kwargs["shell"] is False
        assert kwargs["start_new_session"] is True
        script = "import sys; sys.stdout.write(" + repr(json.dumps(payload)) + ")"
        return real_popen([sys.executable, "-c", script], **kwargs)

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        "app.ffprobe_analyzer._decode_and_extract_frame",
        lambda media_path, timeout_seconds: {
            "status": "passed",
            "decode_window_seconds": 8,
            "sample_frame_bytes": 128,
            "sample_frame_sha256": "a" * 64,
        },
    )
    report = analyze_local_media_file(media)
    assert report["is_4k_bitstream"] is True
    assert report["hdr_bitstream_claim"] is True
    assert report["video"]["frame_rate_fps"] == pytest.approx(59.94, rel=1e-3)
    assert report["native_4k_verified"] is False
    assert report["verification_level"] == "sample_decode_and_frame_extraction"
    assert report["decode_check"]["status"] == "passed"
    assert report["stream_count"] == 3
    assert report["audio_tracks"] == [
        {
            "index": 1,
            "codec": "eac3",
            "profile": "Dolby Digital Plus",
            "language": "zh",
            "title": "国语",
            "is_default": True,
            "is_forced": False,
            "channels": 6,
            "channel_layout": "5.1",
            "sample_rate_hz": 48000,
        }
    ]
    assert report["subtitle_tracks"][0]["language"] == "en"
    assert report["subtitle_tracks"][0]["codec"] == "ass"


def test_probe_rejects_paths_outside_probe_root(tmp_path, monkeypatch):
    root, _ = _media_file(tmp_path)
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"data")
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    with pytest.raises(MediaProbeError, match="inside MEDIA_PROBE_ROOT"):
        analyze_local_media_file(outside)


def test_probe_rejects_symlink(tmp_path, monkeypatch):
    root, media = _media_file(tmp_path)
    link = root / "linked.mp4"
    link.symlink_to(media)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    with pytest.raises(MediaProbeError, match="Symbolic links"):
        analyze_local_media_file(link)


def test_probe_timeout_is_bounded(tmp_path, monkeypatch):
    root, media = _media_file(tmp_path)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    with pytest.raises(MediaProbeError, match="between 1 and 60"):
        analyze_local_media_file(media, timeout_seconds=120)


def test_probe_handles_timeout_and_missing_binary(tmp_path, monkeypatch):
    root, media = _media_file(tmp_path)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))

    real_popen = subprocess.Popen

    def timeout(*args, **kwargs):
        return real_popen([sys.executable, "-c", "import time; time.sleep(3)"], **kwargs)

    monkeypatch.setattr(subprocess, "Popen", timeout)
    with pytest.raises(MediaProbeError, match="timed out"):
        analyze_local_media_file(media, timeout_seconds=1)

    def missing(*args, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(subprocess, "Popen", missing)
    with pytest.raises(MediaProbeError, match="not installed"):
        analyze_local_media_file(media)


def test_probe_rejects_empty_or_invalid_stream_report(tmp_path, monkeypatch):
    root, media = _media_file(tmp_path)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    real_popen = subprocess.Popen

    def invalid_report(command, **kwargs):
        script = "import sys; sys.stdout.write('{\"streams\":[]}')"
        return real_popen([sys.executable, "-c", script], **kwargs)

    monkeypatch.setattr(subprocess, "Popen", invalid_report)
    with pytest.raises(MediaProbeError, match="no readable streams"):
        analyze_local_media_file(media)


def test_probe_stops_process_when_stdout_exceeds_limit(tmp_path, monkeypatch):
    root, media = _media_file(tmp_path)
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))
    real_popen = subprocess.Popen

    def oversized(command, **kwargs):
        script = "import sys; sys.stdout.write('x' * (1024 * 1024 + 1))"
        return real_popen([sys.executable, "-c", script], **kwargs)

    monkeypatch.setattr(subprocess, "Popen", oversized)
    with pytest.raises(MediaProbeError, match="exceeds the 1 MiB limit"):
        analyze_local_media_file(media)


def test_decode_failure_reports_bounded_ffmpeg_diagnostic(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from app.ffprobe_analyzer import _decode_and_extract_frame

    root = tmp_path / "probe"
    root.mkdir()
    monkeypatch.setenv("MEDIA_PROBE_ROOT", str(root))

    def fail_decode(command, **kwargs):
        assert kwargs["shell"] is False
        assert "-threads" in command
        assert "-filter_threads" in command
        assert "-filter_complex_threads" in command
        assert "--as=1073741824" in command
        assert "--stack=1048576:1048576" in command
        assert "taskset" in command
        assert "-xerror" in command
        kwargs["stderr"].write(b"fixture-specific decoder error" + b"x" * 1000)
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr("app.ffprobe_analyzer.subprocess.run", fail_decode)
    with pytest.raises(MediaProbeError, match="fixture-specific decoder error") as error:
        _decode_and_extract_frame(root / "fixture.media", timeout_seconds=10)
    assert len(str(error.value)) < 300


def test_pixel_format_bit_depth_inference():
    from app.ffprobe_analyzer import _pixel_format_bit_depth

    assert _pixel_format_bit_depth("yuv420p10le") == 10
    assert _pixel_format_bit_depth("yuv444p12be") == 12
    assert _pixel_format_bit_depth("p010le") == 10
    assert _pixel_format_bit_depth("yuv420p") == 8
    assert _pixel_format_bit_depth("unknown") is None
