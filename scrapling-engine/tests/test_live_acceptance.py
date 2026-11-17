from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from scripts.verify_live_authorized_scale import load_authorized_urls, run


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
    monkeypatch.setattr("scripts.verify_live_authorized_scale.settings.egress_proxy_url", None)

    args = argparse.Namespace(
        input=source,
        allowed_hosts="93.184.216.34",
        max_urls=1,
    )
    with pytest.raises(ValueError, match="SCRAPLING_EGRESS_PROXY"):
        await run(args)
