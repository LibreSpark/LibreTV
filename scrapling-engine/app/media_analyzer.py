from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any

_ATTRIBUTE = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', re.IGNORECASE)


def _attributes(line: str) -> dict[str, str]:
    return {key.upper(): value.strip().strip('"') for key, value in _ATTRIBUTE.findall(line)}


def _quality_label(height: int | None) -> str:
    if height is None:
        return "unknown"
    if height >= 2160:
        return "4K_claim"
    if height >= 1440:
        return "1440p_claim"
    if height >= 1080:
        return "1080p_claim"
    if height >= 720:
        return "720p_claim"
    return f"{height}p_claim"


def analyze_hls_manifest(manifest: str) -> dict[str, Any]:
    if len(manifest.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("HLS manifest exceeds the 2 MiB analysis limit")
    if not manifest.lstrip().startswith("#EXTM3U"):
        raise ValueError("Input is not an HLS manifest")

    renditions: list[dict[str, Any]] = []
    protection_methods: set[str] = set()
    for line in manifest.splitlines():
        if line.upper().startswith(("#EXT-X-KEY:", "#EXT-X-SESSION-KEY:")):
            method = _attributes(line.split(":", 1)[1]).get("METHOD", "").upper()
            if method and method != "NONE":
                protection_methods.add(method)
    for line in manifest.splitlines():
        if not line.startswith("#EXT-X-STREAM-INF:"):
            continue
        attrs = _attributes(line.split(":", 1)[1])
        resolution = attrs.get("RESOLUTION", "")
        width = height = None
        match = re.fullmatch(r"(\d+)x(\d+)", resolution, re.IGNORECASE)
        if match:
            width, height = int(match.group(1)), int(match.group(2))
        try:
            bandwidth = int(attrs["AVERAGE-BANDWIDTH"])
        except (KeyError, ValueError):
            try:
                bandwidth = int(attrs["BANDWIDTH"])
            except (KeyError, ValueError):
                bandwidth = None
        try:
            frame_rate = float(attrs["FRAME-RATE"])
        except (KeyError, ValueError):
            frame_rate = None
        video_range = attrs.get("VIDEO-RANGE", "SDR").upper()
        renditions.append(
            {
                "width": width,
                "height": height,
                "bandwidth_bps": bandwidth,
                "frame_rate_fps": frame_rate,
                "codecs": attrs.get("CODECS"),
                "video_range": video_range,
                "hdr_claim": video_range in {"PQ", "HLG"},
            }
        )

    best = max(
        renditions,
        key=lambda item: (
            item["height"] or 0,
            item["bandwidth_bps"] or 0,
        ),
        default={},
    )
    height = best.get("height")
    return {
        "container": "hls",
        "protection_state": "protected_or_encrypted" if protection_methods else "none",
        "protection_methods": sorted(protection_methods),
        "rendition_count": len(renditions),
        "renditions": renditions,
        "max_width": best.get("width"),
        "max_height": height,
        "max_bitrate_bps": best.get("bandwidth_bps"),
        "frame_rate_fps": best.get("frame_rate_fps"),
        "codecs": best.get("codecs"),
        "hdr_claim": bool(best.get("hdr_claim", False)),
        "video_range_claim": best.get("video_range", "unknown"),
        "quality_label": _quality_label(height),
        "is_4k_claim": bool(height and height >= 2160),
        "native_4k_verified": False,
        "upscaled_4k": "unknown",
        "verification_level": "manifest_claim_only",
        "limitations": [
            "Manifest metadata is publisher-supplied and can be inaccurate.",
            "Native resolution and upscaling cannot be verified from a manifest alone.",
        ],
    }


def analyze_mpd_manifest(manifest: str) -> dict[str, Any]:
    if len(manifest.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("DASH manifest exceeds the 2 MiB analysis limit")
    upper = manifest.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper:
        raise ValueError("DASH manifest declarations are not accepted")
    try:
        root = ET.fromstring(manifest)
    except ET.ParseError as exc:
        raise ValueError("Invalid DASH MPD XML") from exc
    if root.tag.split("}")[-1] != "MPD":
        raise ValueError("Input is not a DASH MPD manifest")

    representations: list[dict[str, Any]] = []
    protection_schemes = sorted(
        {
            element.attrib.get("schemeIdUri", "unknown")
            for element in root.iter()
            if element.tag.split("}")[-1] == "ContentProtection"
        }
    )
    for element in root.iter():
        if element.tag.split("}")[-1] != "Representation":
            continue
        try:
            width = int(element.attrib["width"]) if "width" in element.attrib else None
            height = int(element.attrib["height"]) if "height" in element.attrib else None
            bandwidth = int(element.attrib["bandwidth"]) if "bandwidth" in element.attrib else None
        except ValueError:
            width = height = bandwidth = None
        frame_rate = element.attrib.get("frameRate")
        hdr_claim = False
        for child in element.iter():
            scheme = child.attrib.get("schemeIdUri", "").lower()
            value = child.attrib.get("value", "").lower()
            if "transfercharacteristics" in scheme and value in {"16", "18"}:
                hdr_claim = True
        representations.append(
            {
                "width": width,
                "height": height,
                "bandwidth_bps": bandwidth,
                "frame_rate": frame_rate,
                "codecs": element.attrib.get("codecs"),
                "hdr_claim": hdr_claim,
            }
        )

    best = max(
        representations,
        key=lambda item: (
            item["height"] or 0,
            item["bandwidth_bps"] or 0,
        ),
        default={},
    )
    height = best.get("height")
    return {
        "container": "dash",
        "protection_state": "protected_or_encrypted" if protection_schemes else "none",
        "protection_schemes": protection_schemes,
        "representation_count": len(representations),
        "representations": representations,
        "max_width": best.get("width"),
        "max_height": height,
        "max_bitrate_bps": best.get("bandwidth_bps"),
        "frame_rate": best.get("frame_rate"),
        "codecs": best.get("codecs"),
        "hdr_claim": bool(best.get("hdr_claim", False)),
        "quality_label": _quality_label(height),
        "is_4k_claim": bool(height and height >= 2160),
        "native_4k_verified": False,
        "upscaled_4k": "unknown",
        "verification_level": "manifest_claim_only",
        "limitations": [
            "MPD representation metadata is publisher-supplied and can be inaccurate.",
            "Native resolution and upscaling cannot be verified from a manifest alone.",
        ],
    }
