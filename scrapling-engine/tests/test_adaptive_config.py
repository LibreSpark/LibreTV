from __future__ import annotations

from pathlib import Path

from scrapling.fetchers import Fetcher


def test_adaptive_storage_is_enabled_and_persisted_under_crawl_data() -> None:
    config = Fetcher.display_config()
    storage_args = config["storage_args"]

    assert config["adaptive"] is True
    assert Path(storage_args["storage_file"]).name == "adaptive.sqlite3"
    assert Path(storage_args["storage_file"]).is_absolute()
