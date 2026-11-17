from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_live_authorized_scale.py"
SPEC = importlib.util.spec_from_file_location("live_scale_acceptance", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
LIVE_SCALE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIVE_SCALE)
load_authorized_urls = LIVE_SCALE.load_authorized_urls
run = LIVE_SCALE.run


def test_live_scale_input_is_deduplicated_and_limited(tmp_path: Path) -> None:
    source = tmp_path / "authorized.txt"
    source.write_text(
        "https://93.184.216.34/catalog\n"
        "https://93.184.216.34/catalog\n"
        "https://93.184.216.34/watch\n",
        encoding="utf-8",
    )

    urls = load_authorized_urls(source, {"93.184.216.34"}, 2)

    assert urls == [
        "https://93.184.216.34/catalog",
        "https://93.184.216.34/watch",
    ]


def test_live_scale_input_rejects_hosts_outside_exact_allowlist(tmp_path: Path) -> None:
    source = tmp_path / "authorized.txt"
    source.write_text("https://93.184.216.34/catalog\n", encoding="utf-8")

    with pytest.raises(ValueError, match="explicit allowlist"):
        load_authorized_urls(source, {"example.com"}, 10)


def test_live_scale_input_rejects_more_than_configured_limit(tmp_path: Path) -> None:
    source = tmp_path / "authorized.txt"
    source.write_text(
        "https://93.184.216.34/one\nhttps://93.184.216.34/two\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="maximum of 1"):
        load_authorized_urls(source, {"93.184.216.34"}, 1)


@pytest.mark.asyncio
async def test_live_scale_requires_controlled_egress_proxy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "authorized.txt"
    source.write_text("https://93.184.216.34/catalog\n", encoding="utf-8")
    monkeypatch.setattr(LIVE_SCALE.settings, "egress_proxy_url", None)

    args = argparse.Namespace(
        input=source,
        allowed_hosts="93.184.216.34",
        max_urls=1,
    )
    with pytest.raises(ValueError, match="SCRAPLING_EGRESS_PROXY"):
        await run(args)
