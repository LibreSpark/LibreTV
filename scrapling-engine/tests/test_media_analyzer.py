from __future__ import annotations

import pytest

from app.media_analyzer import analyze_hls_manifest, analyze_mpd_manifest


def test_hls_manifest_reports_4k_hdr_and_bitrate_as_unverified_claims() -> None:
    manifest = "\n".join(
        [
            "#EXTM3U",
            "#EXT-X-VERSION:6",
            (
                "#EXT-X-STREAM-INF:BANDWIDTH=12000000,"
                "AVERAGE-BANDWIDTH=10000000,RESOLUTION=1920x1080,"
                'FRAME-RATE=30.000,CODECS="avc1.640028",VIDEO-RANGE=SDR'
            ),
            "1080/index.m3u8",
            (
                "#EXT-X-STREAM-INF:BANDWIDTH=28000000,"
                "AVERAGE-BANDWIDTH=24000000,RESOLUTION=3840x2160,"
                'FRAME-RATE=59.940,CODECS="hvc1.2.4.L153.B0",VIDEO-RANGE=PQ'
            ),
            "2160/index.m3u8",
        ]
    )
    report = analyze_hls_manifest(manifest)
    assert report["quality_label"] == "4K_claim"
    assert report["is_4k_claim"] is True
    assert report["hdr_claim"] is True
    assert report["max_width"] == 3840
    assert report["max_height"] == 2160
    assert report["max_bitrate_bps"] == 24000000
    assert report["frame_rate_fps"] == pytest.approx(59.94)
    assert report["native_4k_verified"] is False
    assert report["protection_state"] == "none"
    assert report["upscaled_4k"] == "unknown"
    assert report["verification_level"] == "manifest_claim_only"
    assert report["protection_state"] == "none"


def test_hls_manifest_without_variants_is_not_misreported_as_hd() -> None:
    report = analyze_hls_manifest("#EXTM3U\n#EXT-X-TARGETDURATION:6\n")
    assert report["quality_label"] == "unknown"
    assert report["is_4k_claim"] is False


def test_dash_manifest_extracts_representation_metadata() -> None:
    manifest = """<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
      <Period><AdaptationSet>
        <Representation id="hd" width="1920" height="1080"
          bandwidth="8000000" frameRate="25" codecs="avc1.640028" />
        <Representation id="uhd" width="3840" height="2160"
          bandwidth="22000000" frameRate="50" codecs="hev1.2.4.L153">
          <SupplementalProperty
            schemeIdUri="urn:mpeg:mpegB:cicp:TransferCharacteristics"
            value="16" />
        </Representation>
      </AdaptationSet></Period>
    </MPD>"""
    report = analyze_mpd_manifest(manifest)
    assert report["quality_label"] == "4K_claim"
    assert report["hdr_claim"] is True
    assert report["max_bitrate_bps"] == 22000000
    assert report["native_4k_verified"] is False


def test_dash_manifest_rejects_entity_declarations() -> None:
    with pytest.raises(ValueError, match="declarations"):
        analyze_mpd_manifest('<!DOCTYPE foo [<!ENTITY x "boom">]><MPD>&x;</MPD>')


def test_hls_encryption_is_flagged_as_protected_and_not_playable() -> None:
    report = analyze_hls_manifest(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"\n'
    )
    assert report["protection_state"] == "protected_or_encrypted"
    assert report["protection_methods"] == ["AES-128"]


def test_dash_content_protection_is_flagged() -> None:
    manifest = (
        '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet>'
        '<ContentProtection schemeIdUri="urn:uuid:protected"/>'
        '<Representation id="v1" width="1280" height="720" bandwidth="900000"/>'
        "</AdaptationSet></Period></MPD>"
    )
    report = analyze_mpd_manifest(manifest)
    assert report["protection_state"] == "protected_or_encrypted"
    assert report["protection_schemes"] == ["urn:uuid:protected"]


def test_manifest_analysis_enforces_size_limit() -> None:
    with pytest.raises(ValueError, match="2 MiB"):
        analyze_hls_manifest("#EXTM3U\n" + ("x" * (2 * 1024 * 1024)))
