from app.media_analyzer import analyze_hls_manifest, analyze_mpd_manifest


def test_hls_key_tags_are_marked_protected_and_never_publishable() -> None:
    report = analyze_hls_manifest(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
        "#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nvariant.m3u8\n"
    )
    assert report["protection_state"] == "protected_or_encrypted"
    assert report["protection_methods"] == ["AES-128"]


def test_clear_hls_manifest_has_no_protection_claim() -> None:
    report = analyze_hls_manifest("#EXTM3U\n#EXT-X-TARGETDURATION:6\n")
    assert report["protection_state"] == "none"


def test_dash_content_protection_is_detected() -> None:
    report = analyze_mpd_manifest(
        '<MPD xmlns:cenc="urn:mpeg:cenc:2013"><Period><AdaptationSet>'
        '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'
        '<Representation id="v1" width="1920" height="1080"/>'
        "</AdaptationSet></Period></MPD>"
    )
    assert report["protection_state"] == "protected_or_encrypted"
    assert len(report["protection_schemes"]) == 1
