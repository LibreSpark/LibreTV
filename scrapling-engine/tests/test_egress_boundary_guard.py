from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

GUARD_PATH = Path(__file__).resolve().parents[2] / "scripts" / "check-egress-client-boundary.py"
SPEC = importlib.util.spec_from_file_location("egress_boundary_guard", GUARD_PATH)
assert SPEC is not None and SPEC.loader is not None
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


@pytest.fixture
def app_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    app = tmp_path / "app"
    app.mkdir()
    monkeypatch.setattr(GUARD, "APP", app)
    monkeypatch.setattr(GUARD, "ROOT", tmp_path)
    return app


@pytest.mark.parametrize(
    "source",
    [
        "import requests",
        "import aiohttp",
        "from urllib import request",
        "from urllib.request import urlopen",
        "import urllib3",
        "from http.client import HTTPConnection",
        "import httpx",
        "from httpx import AsyncClient as Client",
    ],
)
def test_rejects_direct_network_client_imports_outside_adapters(app_dir: Path, source: str) -> None:
    target = app_dir / "untrusted.py"
    target.write_text(source, encoding="utf-8")

    errors = GUARD.inspect_file(target)

    assert errors, f"Expected outbound boundary violation for: {source}"


@pytest.mark.parametrize(
    "source",
    [
        '__import__("requests")',
        '__import__("urllib.request")',
        'import importlib; importlib.import_module("aiohttp")',
        'from importlib import import_module as load; load("httpx")',
        'import importlib as il; il.import_module("urllib.request")',
        'import importlib.util; importlib.util.import_module("requests")',
        'import builtins as bi; bi.__import__("aiohttp")',
        'from builtins import __import__ as imp; imp("urllib.request")',
    ],
)
def test_rejects_literal_dynamic_network_client_imports(app_dir: Path, source: str) -> None:
    target = app_dir / "untrusted.py"
    target.write_text(source, encoding="utf-8")

    errors = GUARD.inspect_file(target)

    assert errors, f"Expected dynamic import violation for: {source}"


@pytest.mark.parametrize(
    "source",
    [
        "import httpx\nclient = httpx.AsyncClient(proxy=EGRESS_PROXY, trust_env=False)",
        (
            "from httpx import Client as HttpClient\n"
            "client = HttpClient(proxy=EGRESS_PROXY, trust_env=False)"
        ),
    ],
)
def test_allows_explicitly_configured_httpx_only_in_approved_adapter(
    app_dir: Path, source: str
) -> None:
    target = app_dir / "supervisor.py"
    target.write_text(source, encoding="utf-8")

    assert GUARD.inspect_file(target) == []


@pytest.mark.parametrize(
    "source",
    [
        "import httpx\nclient = httpx.AsyncClient(proxy=EGRESS_PROXY)",
        "import httpx\nclient = httpx.Client(trust_env=False)",
        "from httpx import AsyncClient as Client\nclient = Client(proxy=None, trust_env=False)",
    ],
)
def test_rejects_httpx_clients_without_both_proxy_guards(app_dir: Path, source: str) -> None:
    target = app_dir / "supervisor.py"
    target.write_text(source, encoding="utf-8")

    errors = GUARD.inspect_file(target)

    assert len(errors) == 1
