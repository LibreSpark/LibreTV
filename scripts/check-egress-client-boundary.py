#!/usr/bin/env python3
"""Fail CI when new direct outbound HTTP clients bypass reviewed adapters."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "scrapling-engine" / "app"
HTTPX_ADAPTERS = {"supervisor.py", "media_downloader.py"}
SCRAPLING_ADAPTERS = {"scraper.py", "spider.py", "robots.py"}
HTTP_CLIENT_MODULES = (
    "httpx",
    "requests",
    "aiohttp",
    "urllib3",
    "urllib.request",
    "http.client",
)


def is_http_client_module(module: str) -> bool:
    if module == "urllib":
        return True
    if module.startswith("urllib.") and module not in {"urllib.parse", "urllib.robotparser"}:
        return True
    return any(module == item or module.startswith(f"{item}.") for item in HTTP_CLIENT_MODULES)


def inspect_file(path: Path) -> list[str]:
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        return [f"{path.relative_to(ROOT)}:{exc.lineno}: cannot parse Python source: {exc.msg}"]

    relative = path.relative_to(APP)
    filename = relative.name
    errors: list[str] = []
    httpx_module_aliases: set[str] = set()
    httpx_client_symbols: set[str] = set()
    importlib_aliases: set[str] = set()
    builtin_import_aliases: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if is_http_client_module(alias.name):
                    if not alias.name.startswith("httpx") or filename not in HTTPX_ADAPTERS:
                        errors.append(
                            f"{relative}:{node.lineno}: direct {alias.name} import is outside an approved adapter"
                        )
                    if alias.name == "httpx":
                        httpx_module_aliases.add(alias.asname or "httpx")
                if alias.name == "scrapling.fetchers" and filename not in SCRAPLING_ADAPTERS:
                    errors.append(
                        f"{relative}:{node.lineno}: Scrapling fetcher import is outside an approved adapter"
                    )
                if alias.name == "importlib" or alias.name.startswith("importlib."):
                    importlib_aliases.add(alias.asname or alias.name.split(".")[0])
                if alias.name == "builtins":
                    builtin_import_aliases.add(alias.asname or "builtins")

        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if is_http_client_module(module):
                if not module.startswith("httpx") or filename not in HTTPX_ADAPTERS:
                    errors.append(
                        f"{relative}:{node.lineno}: direct {module} import is outside an approved adapter"
                    )
            if module == "scrapling.fetchers" and filename not in SCRAPLING_ADAPTERS:
                errors.append(
                    f"{relative}:{node.lineno}: Scrapling fetcher import is outside an approved adapter"
                )
            if module == "httpx" and filename in HTTPX_ADAPTERS:
                httpx_client_symbols.update(
                    alias.asname or alias.name
                    for alias in node.names
                    if alias.name in {"Client", "AsyncClient"}
                )
            if module == "importlib":
                importlib_aliases.update(
                    alias.asname or alias.name
                    for alias in node.names
                    if alias.name == "import_module"
                )
            if module == "builtins":
                builtin_import_aliases.update(
                    alias.asname or alias.name
                    for alias in node.names
                    if alias.name == "__import__"
                )

        elif isinstance(node, ast.Call):
            # Catch common dynamic-import escapes when the module name is literal.
            dynamic_import = (
                isinstance(node.func, ast.Name)
                and node.func.id == "__import__"
            )
            dynamic_import = dynamic_import or (
                isinstance(node.func, ast.Name)
                and node.func.id in importlib_aliases | builtin_import_aliases
            )
            dynamic_import = dynamic_import or (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "__import__"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in builtin_import_aliases
            )
            importlib_root = node.func.value if isinstance(node.func, ast.Attribute) else None
            while isinstance(importlib_root, ast.Attribute):
                importlib_root = importlib_root.value
            dynamic_import = dynamic_import or (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "import_module"
                and isinstance(importlib_root, ast.Name)
                and importlib_root.id in importlib_aliases
            )
            if dynamic_import and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    if is_http_client_module(arg.value):
                        errors.append(
                            f"{relative}:{node.lineno}: dynamic network-client import is forbidden"
                        )

            client_name = None
            if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                if node.func.value.id in httpx_module_aliases:
                    client_name = node.func.attr
            elif isinstance(node.func, ast.Name) and node.func.id in httpx_client_symbols:
                client_name = node.func.id

            if client_name in {"Client", "AsyncClient"}:
                keywords = {item.arg: item.value for item in node.keywords if item.arg}
                trust_env = keywords.get("trust_env")
                proxy = keywords.get("proxy")
                if not isinstance(trust_env, ast.Constant) or trust_env.value is not False:
                    errors.append(
                        f"{relative}:{node.lineno}: httpx {client_name} must set trust_env=False"
                    )
                if proxy is None or (
                    isinstance(proxy, ast.Constant) and proxy.value in (None, "")
                ):
                    errors.append(
                        f"{relative}:{node.lineno}: httpx {client_name} must receive an explicit egress proxy"
                    )

    return errors


def main() -> int:
    errors: list[str] = []
    for path in sorted(APP.rglob("*.py")):
        errors.extend(inspect_file(path))
    if errors:
        print("Outbound-client boundary violations:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print("Outbound-client import boundary passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
