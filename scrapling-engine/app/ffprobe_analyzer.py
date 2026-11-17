from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

DEFAULT_PROBE_ROOT = Path("/tmp/libretv-media-probe")
MAX_MEDIA_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROBE_OUTPUT_BYTES = 1024 * 1024
PROBE_TIMEOUT_SECONDS = 20


class MediaProbeError(ValueError):
    """A local media file could not be safely or reliably probed."""


def _probe_root() -> Path:
    root = Path(os.environ.get("MEDIA_PROBE_ROOT", str(DEFAULT_PROBE_ROOT)))
    if root.is_symlink():
        raise MediaProbeError("The media probe root cannot be a symbolic link")
    if not root.exists():
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir():
        raise MediaProbeError("The media probe root must be a directory")
    return root.resolve(strict=True)


def _safe_media_path(path: str | Path) -> Path:
    candidate = Path(path)
    if candidate.is_symlink():
        raise MediaProbeError("Symbolic links are not accepted for media probing")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(_probe_root())
    except (OSError, ValueError) as exc:
        raise MediaProbeError("Media file must exist inside MEDIA_PROBE_ROOT") from exc
    try:
        metadata = resolved.stat()
    except OSError as exc:
        raise MediaProbeError("Media file cannot be inspected") from exc
    if not stat.S_ISREG(metadata.st_mode):
        raise MediaProbeError("Only regular local media files can be probed")
    if metadata.st_size <= 0:
        raise MediaProbeError("Media file is empty")
    if metadata.st_size > MAX_MEDIA_FILE_BYTES:
        raise MediaProbeError("Media file exceeds the 2 GiB probe limit")
    return resolved


def _ratio(value: Any) -> float | None:
    if not isinstance(value, str) or "/" not in value:
        return None
    numerator, denominator = value.split("/", 1)
    try:
        divisor = float(denominator)
        return float(numerator) / divisor if divisor else None
    except ValueError:
        return None


def _single_cpu() -> str:
    try:
        cpus = os.sched_getaffinity(0)
    except (AttributeError, OSError) as exc:
        raise MediaProbeError("Unable to determine the isolated probe CPU set") from exc
    if not cpus:
        raise MediaProbeError("The isolated probe has no available CPU")
    return str(min(cpus))


def _run_limited_ffmpeg(command: list[str], timeout_seconds: int) -> tuple[int, str]:
    with tempfile.TemporaryFile(dir="/tmp") as diagnostics:
        completed = subprocess.run(  # noqa: S603
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=diagnostics,
            shell=False,
            cwd=str(_probe_root()),
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"},
            close_fds=True,
            timeout=timeout_seconds,
            check=False,
        )
        diagnostics.seek(0)
        detail = " ".join(diagnostics.read(4096).decode("utf-8", "replace").split())
    return completed.returncode, detail[:240]


def _decode_and_extract_frame(media_path: Path, timeout_seconds: int) -> dict[str, Any]:
    phase_timeout = max(1, timeout_seconds // 2)
    base = [
        "prlimit",
        f"--cpu={phase_timeout}:{phase_timeout + 5}",
        "--as=1073741824",
        "--stack=1048576:1048576",
        "--core=0:0",
        "--nofile=64:64",
        "--fsize=2097152:2097152",
        "--",
        "taskset",
        "-c",
        _single_cpu(),
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-err_detect",
        "explode",
        "-protocol_whitelist",
        "file",
        "-max_alloc",
        str(64 * 1024 * 1024),
        "-probesize",
        str(10 * 1024 * 1024),
        "-analyzeduration",
        str(10 * 1000 * 1000),
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
        "-i",
        str(media_path),
    ]
    try:
        decode_command = [*base, "-t", "8", "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"]
        decode_code, decode_detail = _run_limited_ffmpeg(decode_command, phase_timeout)
        if decode_code != 0:
            suffix = f": {decode_detail}" if decode_detail else ""
            raise MediaProbeError(f"FFmpeg detected a decode error (exit {decode_code}){suffix}")
        with tempfile.NamedTemporaryFile(
            prefix="libretv-frame-", suffix=".jpg", dir="/tmp", delete=False
        ) as output:
            frame_path = Path(output.name)
        try:
            extract_command = [
                *base,
                "-frames:v",
                "1",
                "-vf",
                "scale='min(640,iw)':-2",
                "-an",
                "-f",
                "image2",
                "-vcodec",
                "mjpeg",
                "-y",
                str(frame_path),
            ]
            extract_code, extract_detail = _run_limited_ffmpeg(extract_command, phase_timeout)
            if extract_code != 0:
                suffix = f": {extract_detail}" if extract_detail else ""
                raise MediaProbeError(
                    f"FFmpeg could not extract a sample frame (exit {extract_code}){suffix}"
                )
            size = frame_path.stat().st_size
            if not 1 <= size <= 2 * 1024 * 1024:
                raise MediaProbeError("Extracted sample frame is empty or exceeds 2 MiB")
            digest = hashlib.sha256()
            with frame_path.open("rb") as frame:
                for chunk in iter(lambda: frame.read(64 * 1024), b""):
                    digest.update(chunk)
        finally:
            frame_path.unlink(missing_ok=True)
    except FileNotFoundError as exc:
        raise MediaProbeError("ffmpeg is not installed in the probe image") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaProbeError("FFmpeg media sample verification timed out") from exc
    return {
        "status": "passed",
        "decode_window_seconds": 8,
        "sample_frame_bytes": size,
        "sample_frame_sha256": digest.hexdigest(),
    }


def analyze_local_media_file(
    path: str | Path,
    *,
    timeout_seconds: int = PROBE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Probe a previously downloaded local file; ffprobe is never given a network URL."""
    if not 1 <= timeout_seconds <= 60:
        raise MediaProbeError("Probe timeout must be between 1 and 60 seconds")
    media_path = _safe_media_path(path)
    command = [
        "prlimit",
        f"--cpu={timeout_seconds}:{timeout_seconds + 5}",
        "--as=402653184",
        "--core=0:0",
        "--nofile=64:64",
        "--",
        "taskset",
        "-c",
        _single_cpu(),
        "ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-max_alloc",
        str(64 * 1024 * 1024),
        "-probesize",
        str(10 * 1024 * 1024),
        "-analyzeduration",
        str(10 * 1000 * 1000),
        "-threads",
        "1",
        "-show_entries",
        "format=format_name,duration,size,bit_rate:"
        "stream=index,codec_type,codec_name,profile,width,height,pix_fmt,"
        "avg_frame_rate,r_frame_rate,bit_rate,color_range,color_space,"
        "color_transfer,color_primaries,bits_per_raw_sample,channels,"
        "channel_layout,sample_rate:"
        "stream_tags=language,title:"
        "stream_disposition=default,forced:"
        "stream_side_data=side_data_type,dv_profile,dv_level,rpu_present,el_present,bl_present",
        "-of",
        "json",
        str(media_path),
    ]
    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout_seconds
    try:
        # Fixed argv, validated local path, and shell=False; no user-controlled command.
        process = subprocess.Popen(  # noqa: S603
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            cwd=str(_probe_root()),
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"},
            close_fds=True,
            start_new_session=True,
        )
    except FileNotFoundError as exc:
        raise MediaProbeError("ffprobe is not installed in the worker image") from exc

    assert process.stdout is not None and process.stderr is not None
    streams = {
        process.stdout: (stdout, MAX_PROBE_OUTPUT_BYTES, "stdout"),
        process.stderr: (stderr, 64 * 1024, "stderr"),
    }
    selector = selectors.DefaultSelector()
    try:
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MediaProbeError("Media probe timed out")
            for key, _ in selector.select(min(remaining, 0.25)):
                stream = key.fileobj
                chunk = os.read(stream.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(stream)
                    stream.close()
                    continue
                buffer, limit, label = streams[stream]
                if len(buffer) + len(chunk) > limit:
                    raise MediaProbeError(
                        "ffprobe output exceeds the 1 MiB limit"
                        if label == "stdout"
                        else "ffprobe diagnostics exceed the 64 KiB limit"
                    )
                buffer.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MediaProbeError("Media probe timed out")
        return_code = process.wait(timeout=remaining)
    except (subprocess.TimeoutExpired, TimeoutError) as exc:
        raise MediaProbeError("Media probe timed out") from exc
    except BaseException:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        raise
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr):
            if not stream.closed:
                stream.close()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()

    if return_code != 0:
        raise MediaProbeError("ffprobe could not parse the local media file")
    try:
        payload = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MediaProbeError("ffprobe returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise MediaProbeError("ffprobe returned an invalid report")
    streams = payload.get("streams")
    if not isinstance(streams, list) or not streams:
        raise MediaProbeError("Media file contains no readable streams")

    video = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "video"
        ),
        None,
    )
    if video is None:
        raise MediaProbeError("Media file contains no video stream")
    width = video.get("width") if isinstance(video.get("width"), int) else None
    height = video.get("height") if isinstance(video.get("height"), int) else None
    transfer = str(video.get("color_transfer") or "").lower()
    hdr = transfer in {"smpte2084", "arib-std-b67"}
    side_data = video.get("side_data_list")
    side_data_items = [item for item in side_data or [] if isinstance(item, dict)]
    side_data_types = [
        item.get("side_data_type")
        for item in side_data_items
        if isinstance(item.get("side_data_type"), str)
    ]
    dolby_vision_data = next(
        (
            item
            for item in side_data_items
            if "dovi" in str(item.get("side_data_type") or "").lower()
            or "dolby vision" in str(item.get("side_data_type") or "").lower()
            or item.get("dv_profile") is not None
        ),
        None,
    )
    pixel_format = video.get("pix_fmt")
    encoded_bit_depth = _safe_int(video.get("bits_per_raw_sample"))
    if encoded_bit_depth is None:
        encoded_bit_depth = _pixel_format_bit_depth(pixel_format)
    if dolby_vision_data:
        hdr_format_claim = "dolby_vision"
    elif transfer == "smpte2084" and str(video.get("color_primaries") or "").lower() == "bt2020":
        hdr_format_claim = "hdr10_or_pq"
    elif transfer == "arib-std-b67":
        hdr_format_claim = "hlg"
    elif hdr:
        hdr_format_claim = "hdr_metadata_other"
    else:
        hdr_format_claim = "unknown" if not transfer else "sdr_or_unclassified"
    format_info = payload.get("format")
    format_info = format_info if isinstance(format_info, dict) else {}
    decode_check = _decode_and_extract_frame(media_path, timeout_seconds)
    audio_tracks = []
    subtitle_tracks = []
    for stream in streams:
        if not isinstance(stream, dict):
            continue
        tags = stream.get("tags")
        tags = tags if isinstance(tags, dict) else {}
        disposition = stream.get("disposition")
        disposition = disposition if isinstance(disposition, dict) else {}
        track = {
            "index": _safe_int(stream.get("index")),
            "codec": stream.get("codec_name"),
            "profile": stream.get("profile"),
            "language": tags.get("language"),
            "title": tags.get("title"),
            "is_default": bool(disposition.get("default", 0)),
            "is_forced": bool(disposition.get("forced", 0)),
        }
        if stream.get("codec_type") == "audio":
            track.update(
                {
                    "channels": _safe_int(stream.get("channels")),
                    "channel_layout": stream.get("channel_layout"),
                    "sample_rate_hz": _safe_int(stream.get("sample_rate")),
                }
            )
            audio_tracks.append(track)
        elif stream.get("codec_type") == "subtitle":
            subtitle_tracks.append(track)
    is_4k = bool(width and height and width >= 3840 and height >= 2160)
    return {
        "container": format_info.get("format_name"),
        "stream_count": len(streams),
        "audio_tracks": audio_tracks,
        "subtitle_tracks": subtitle_tracks,
        "duration_seconds": _safe_float(format_info.get("duration")),
        "file_size_bytes": _safe_int(format_info.get("size")) or media_path.stat().st_size,
        "container_bitrate_bps": _safe_int(format_info.get("bit_rate")),
        "video": {
            "codec": video.get("codec_name"),
            "profile": video.get("profile"),
            "width": width,
            "height": height,
            "pixel_format": pixel_format,
            "bit_depth": encoded_bit_depth,
            "frame_rate_fps": (
                _ratio(video.get("avg_frame_rate")) or _ratio(video.get("r_frame_rate"))
            ),
            "bitrate_bps": _safe_int(video.get("bit_rate")),
            "color_range": video.get("color_range"),
            "color_space": video.get("color_space"),
            "color_transfer": video.get("color_transfer"),
            "color_primaries": video.get("color_primaries"),
            "bits_per_raw_sample": _safe_int(video.get("bits_per_raw_sample")),
            "side_data_types": side_data_types,
            "dolby_vision_metadata": (
                {
                    "profile": _safe_int(dolby_vision_data.get("dv_profile")),
                    "level": _safe_int(dolby_vision_data.get("dv_level")),
                    "rpu_present": bool(dolby_vision_data.get("rpu_present", 0)),
                    "enhancement_layer_present": bool(dolby_vision_data.get("el_present", 0)),
                    "base_layer_present": bool(dolby_vision_data.get("bl_present", 0)),
                }
                if dolby_vision_data
                else None
            ),
            "hdr_format_claim": hdr_format_claim,
        },
        "resolution_verified": True,
        "is_4k_bitstream": is_4k,
        "hdr_bitstream_claim": hdr,
        "native_4k_verified": False,
        "upscaled_4k": "unknown",
        "verification_level": "sample_decode_and_frame_extraction",
        "decode_check": decode_check,
        "protection_state": "none_detected",
        "limitations": [
            (
                "ffprobe reads encoded stream dimensions and metadata; it cannot prove "
                "the source was natively captured or mastered at 4K."
            ),
            (
                "HDR classification is based on stream color metadata and may still "
                "be missing or incorrect."
            ),
            (
                "FFmpeg decodes up to eight seconds and extracts a sample frame; "
                "this is not a full-file damage scan or visual quality assessment."
            ),
        ],
    }


def _pixel_format_bit_depth(pixel_format: Any) -> int | None:
    """Infer component depth from common FFmpeg pixel-format names."""
    if not isinstance(pixel_format, str):
        return None
    normalized = pixel_format.lower()
    match = re.search(r"p(9|10|12|14|16)(?:le|be)?$", normalized)
    if match:
        return int(match.group(1))
    packed = re.fullmatch(r"p0(10|12|16)(?:le|be)?", normalized)
    if packed:
        return int(packed.group(1))
    if re.search(r"(?:yuv|yuva|gbr|gray|ya).*p$", normalized):
        return 8
    return None


def _safe_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
