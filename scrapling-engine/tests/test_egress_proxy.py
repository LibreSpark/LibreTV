from __future__ import annotations

import asyncio
import ipaddress
import shutil
import socket
import ssl
import subprocess

import pytest

from app.egress_proxy import (
    EgressDenied,
    open_pinned_connection,
    resolve_public_addresses,
)


def _record(address: str):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sockaddr = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)


@pytest.mark.asyncio
async def test_resolver_accepts_public_addresses_and_returns_all_records():
    async def resolver(host, port, type):
        assert host == "public.example"
        assert port == 443
        assert type == socket.SOCK_STREAM
        return [_record("93.184.216.34"), _record("2606:2800:220:1:248:1893:25c8:1946")]

    addresses = await resolve_public_addresses("public.example", 443, resolver=resolver)
    assert [str(address) for address in addresses] == [
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
    ]


@pytest.mark.asyncio
async def test_resolver_rejects_mixed_public_and_private_answers():
    async def resolver(host, port, type):
        return [_record("93.184.216.34"), _record("10.0.0.8")]

    with pytest.raises(EgressDenied, match="Every resolved address"):
        await resolve_public_addresses("rebinding.example", 443, resolver=resolver)


@pytest.mark.asyncio
async def test_resolver_rejects_metadata_and_local_names():
    with pytest.raises(EgressDenied):
        await resolve_public_addresses("169.254.169.254", 443)
    with pytest.raises(EgressDenied):
        await resolve_public_addresses("metadata.local", 443)


@pytest.mark.asyncio
async def test_open_connection_uses_pinned_ip_not_hostname(monkeypatch):
    pinned = ["93.184.216.34"]
    observed = {}

    async def fake_resolve(host, port):
        assert host == "public.example"
        assert port == 443
        return [ipaddress.ip_address(pinned[0])]

    async def fake_open_connection(host, port):
        observed["host"] = host
        observed["port"] = port
        return object(), object()

    monkeypatch.setattr("app.egress_proxy.resolve_public_addresses", fake_resolve)
    monkeypatch.setattr(asyncio, "open_connection", fake_open_connection)
    _reader, _writer, address = await open_pinned_connection("public.example", 443)
    assert observed == {"host": "93.184.216.34", "port": 443}
    assert str(address) == "93.184.216.34"


@pytest.mark.asyncio
async def test_connect_proxy_tunnels_tls_bytes_to_pinned_peer(monkeypatch):
    from app import egress_proxy

    async def echo(reader, writer):
        payload = await reader.readexactly(16)
        writer.write(payload)
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    target_server = await asyncio.start_server(echo, "127.0.0.1", 0)
    target_port = target_server.sockets[0].getsockname()[1]

    async def fake_open_pinned_connection(host, port):
        assert host == "example.com"
        assert port == 443
        return await asyncio.open_connection("127.0.0.1", target_port) + (
            ipaddress.ip_address("93.184.216.34"),
        )

    monkeypatch.setattr(egress_proxy, "open_pinned_connection", fake_open_pinned_connection)
    proxy_server = await asyncio.start_server(egress_proxy.handle_client, "127.0.0.1", 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        await writer.drain()
        response = await reader.readuntil(b"\r\n\r\n")
        assert response.startswith(b"HTTP/1.1 200")
        writer.write(b"tls-client-hello")
        await writer.drain()
        assert await asyncio.wait_for(reader.readexactly(16), timeout=3) == b"tls-client-hello"
        writer.close()
        await writer.wait_closed()
    finally:
        proxy_server.close()
        target_server.close()
        await proxy_server.wait_closed()
        await target_server.wait_closed()


@pytest.mark.asyncio
async def test_parallel_connect_tunnels_are_not_serialized_by_site_governor(monkeypatch):
    from app import egress_proxy
    from app.site_governor import SiteGovernor

    release_targets = asyncio.Event()
    accepted = 0

    async def target(_reader, writer):
        nonlocal accepted
        accepted += 1
        await release_targets.wait()
        writer.close()
        await writer.wait_closed()

    target_server = await asyncio.start_server(target, "127.0.0.1", 0)
    target_port = target_server.sockets[0].getsockname()[1]
    monkeypatch.setattr(egress_proxy, "site_governor", SiteGovernor(minimum_interval_seconds=0))

    async def fake_open_pinned_connection(host, port):
        assert host == "example.com"
        assert port == 443
        reader, writer = await asyncio.open_connection("127.0.0.1", target_port)
        return reader, writer, ipaddress.ip_address("93.184.216.34")

    monkeypatch.setattr(egress_proxy, "open_pinned_connection", fake_open_pinned_connection)
    proxy_server = await asyncio.start_server(egress_proxy.handle_client, "127.0.0.1", 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]
    clients = []
    try:
        for _ in range(2):
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            clients.append(writer)
            writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
            await writer.drain()
            response = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=3)
            assert response.startswith(b"HTTP/1.1 200")
        assert accepted == 2
    finally:
        release_targets.set()
        for writer in clients:
            writer.close()
            await writer.wait_closed()
        proxy_server.close()
        target_server.close()
        await proxy_server.wait_closed()
        await target_server.wait_closed()


@pytest.mark.asyncio
async def test_http_proxy_rewrites_absolute_target_and_closes_connection(monkeypatch):
    from app import egress_proxy

    observed = {}

    async def target(reader, writer):
        observed["request"] = await reader.readuntil(b"\r\n\r\n")
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    target_server = await asyncio.start_server(target, "127.0.0.1", 0)
    target_port = target_server.sockets[0].getsockname()[1]

    async def fake_open_pinned_connection(host, port):
        assert host == "example.com"
        assert port == 80
        return await asyncio.open_connection("127.0.0.1", target_port) + (
            ipaddress.ip_address("93.184.216.34"),
        )

    monkeypatch.setattr(egress_proxy, "open_pinned_connection", fake_open_pinned_connection)
    proxy_server = await asyncio.start_server(egress_proxy.handle_client, "127.0.0.1", 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
        writer.write(
            b"GET http://example.com/catalog?q=1 HTTP/1.1\r\n"
            b"Host: example.com\r\n"
            b"Proxy-Connection: keep-alive\r\n\r\n"
        )
        await writer.drain()
        response = await reader.read()
        assert response.startswith(b"HTTP/1.1 200 OK")
        assert b"GET /catalog?q=1 HTTP/1.1" in observed["request"]
        assert b"Proxy-Connection" not in observed["request"]
        writer.close()
        await writer.wait_closed()
    finally:
        proxy_server.close()
        target_server.close()
        await proxy_server.wait_closed()
        await target_server.wait_closed()


@pytest.mark.asyncio
async def test_http_redirect_to_metadata_is_revalidated_by_proxy(monkeypatch):
    from scrapling.fetchers import Fetcher

    from app import egress_proxy

    async def redirect_to_metadata(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(
            b"HTTP/1.1 302 Found\r\n"
            b"Location: http://169.254.169.254/latest/meta-data/\r\n"
            b"Content-Length: 0\r\n"
            b"Connection: close\r\n\r\n"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    target_server = await asyncio.start_server(
        redirect_to_metadata,
        "127.0.0.1",
        0,
    )
    target_port = target_server.sockets[0].getsockname()[1]
    real_resolve = egress_proxy.resolve_public_addresses

    async def fake_resolve(host, port):
        if host == "redirect.test":
            return [ipaddress.ip_address("127.0.0.1")]
        return await real_resolve(host, port)

    monkeypatch.setattr(egress_proxy, "resolve_public_addresses", fake_resolve)

    async def fake_open_pinned_connection(host, port):
        addresses = await egress_proxy.resolve_public_addresses(host, port)
        if host == "redirect.test":
            reader, writer = await asyncio.open_connection("127.0.0.1", target_port)
            return reader, writer, addresses[0]
        raise egress_proxy.EgressDenied("non-public redirect denied")

    monkeypatch.setattr(
        egress_proxy,
        "open_pinned_connection",
        fake_open_pinned_connection,
    )
    proxy_server = await asyncio.start_server(egress_proxy.handle_client, "127.0.0.1", 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]
    try:
        page = await asyncio.to_thread(
            Fetcher.get,
            "http://redirect.test/",
            timeout=5,
            follow_redirects=True,
            proxy=f"http://127.0.0.1:{proxy_port}",
            impersonate=None,
            stealthy_headers=False,
        )
        assert page.status == 403
    finally:
        proxy_server.close()
        target_server.close()
        await proxy_server.wait_closed()
        await target_server.wait_closed()


@pytest.mark.asyncio
async def test_public_ipv4_mapped_ipv6_literal_is_pinned_as_ipv4():
    addresses = await resolve_public_addresses("::ffff:93.184.216.34", 443)
    assert len(addresses) == 1
    assert addresses[0].version == 4
    assert str(addresses[0]) == "93.184.216.34"


@pytest.mark.asyncio
async def test_private_ipv4_mapped_ipv6_literal_is_rejected():
    with pytest.raises(EgressDenied):
        await resolve_public_addresses("::ffff:127.0.0.1", 443)


@pytest.mark.asyncio
@pytest.mark.parametrize("address", ["224.0.0.1", "240.0.0.1", "255.255.255.255"])
async def test_proxy_rejects_multicast_and_reserved_ip_literals(address: str):
    with pytest.raises(EgressDenied):
        await resolve_public_addresses(address, 443)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        [b"Transfer-Encoding: chunked"],
        [b"Content-Length: not-a-number"],
        [b"Content-Length: 1"],
        [b"MalformedHeaderWithoutColon"],
    ],
)
async def test_http_proxy_rejects_invalid_headers_before_opening_target(monkeypatch, headers):
    from app import egress_proxy

    async def unexpected_open(*args, **kwargs):
        raise AssertionError("Outbound socket opened before request validation")

    monkeypatch.setattr(egress_proxy, "open_pinned_connection", unexpected_open)
    with pytest.raises(EgressDenied):
        await egress_proxy._handle_http(
            "GET http://example.com/catalog HTTP/1.1",
            headers,
            object(),
            object(),
        )


@pytest.mark.asyncio
async def test_dns_rebinding_second_resolution_rejects_private_answer():
    answers = iter(
        [
            [_record("93.184.216.34")],
            [_record("169.254.169.254")],
        ]
    )

    async def resolver(host, port, type):
        return next(answers)

    first = await resolve_public_addresses("rebind.example", 443, resolver=resolver)
    assert [str(address) for address in first] == ["93.184.216.34"]

    with pytest.raises(EgressDenied, match="Every resolved address"):
        await resolve_public_addresses("rebind.example", 443, resolver=resolver)


@pytest.mark.asyncio
async def test_pinned_connection_re_resolves_and_blocks_dns_rebinding(monkeypatch):
    loop = asyncio.get_running_loop()
    answers = iter(
        [
            [_record("93.184.216.34")],
            [_record("169.254.169.254")],
        ]
    )
    connected = []

    async def controlled_getaddrinfo(host, port, type):
        assert host == "rebind.example"
        assert port == 443
        return next(answers)

    async def fake_open_connection(host, port):
        connected.append((host, port))
        return object(), object()

    monkeypatch.setattr(loop, "getaddrinfo", controlled_getaddrinfo)
    monkeypatch.setattr(asyncio, "open_connection", fake_open_connection)

    _reader, _writer, pinned = await open_pinned_connection("rebind.example", 443)
    assert str(pinned) == "93.184.216.34"
    assert connected == [("93.184.216.34", 443)]

    with pytest.raises(EgressDenied, match="globally routable"):
        await open_pinned_connection("rebind.example", 443)
    assert connected == [("93.184.216.34", 443)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    [
        "https://example.com/",
        "ftp://example.com/file",
        "file:///etc/passwd",
        "http://example.com:8080/",
    ],
)
async def test_http_proxy_rejects_unsupported_scheme_ports_and_private_targets(
    monkeypatch, target: str
):
    from app import egress_proxy

    async def unexpected_open(*args, **kwargs):
        raise AssertionError("Outbound socket opened for a denied target")

    monkeypatch.setattr(egress_proxy, "open_pinned_connection", unexpected_open)
    with pytest.raises(EgressDenied):
        await egress_proxy._handle_http(
            f"GET {target} HTTP/1.1",
            [],
            object(),
            object(),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    [
        "http://127.0.0.1/",
        "http://10.0.0.8/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[fd00::1]/",
    ],
)
async def test_http_proxy_rejects_private_ip_before_connecting(target: str):
    from app import egress_proxy

    with pytest.raises(EgressDenied):
        await egress_proxy.open_pinned_connection(
            target.split("//", 1)[1].split("/", 1)[0].strip("[]"),
            80,
        )


@pytest.mark.asyncio
async def test_connect_proxy_preserves_tls_sni_and_hostname_verification(tmp_path, monkeypatch):
    from app import egress_proxy

    openssl = shutil.which("openssl")
    if not openssl:
        pytest.skip("openssl is required to create the ephemeral TLS fixture")
    cert = tmp_path / "server.crt"
    key = tmp_path / "server.key"
    # Fixed OpenSSL fixture command; all paths are generated by pytest.  # noqa: S603
    subprocess.run(  # noqa: S603
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=example.test",
            "-addext",
            "subjectAltName=DNS:example.test",
        ],
        check=True,
        capture_output=True,
        timeout=15,
    )

    observed_sni = []
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(str(cert), str(key))
    server_context.set_servername_callback(
        lambda _ssl_object, server_name, _context: observed_sni.append(server_name)
    )

    async def tls_handler(_reader, writer):
        writer.write(b"ok")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    target_server = await asyncio.start_server(tls_handler, "127.0.0.1", 0, ssl=server_context)
    target_port = target_server.sockets[0].getsockname()[1]

    async def fake_open_pinned_connection(host, port):
        assert host == "example.test"
        assert port == 443
        reader, writer = await asyncio.open_connection("127.0.0.1", target_port)
        return reader, writer, ipaddress.ip_address("93.184.216.34")

    monkeypatch.setattr(egress_proxy, "open_pinned_connection", fake_open_pinned_connection)
    proxy_server = await asyncio.start_server(egress_proxy.handle_client, "127.0.0.1", 0)
    proxy_port = proxy_server.sockets[0].getsockname()[1]

    def tls_client():
        raw = socket.create_connection(("127.0.0.1", proxy_port), timeout=5)
        raw.sendall(b"CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n")
        response = bytearray()
        while not response.endswith(b"\r\n\r\n"):
            response.extend(raw.recv(1))
        assert response.startswith(b"HTTP/1.1 200"), bytes(response)
        context = ssl.create_default_context(cafile=str(cert))
        with context.wrap_socket(raw, server_hostname="example.test") as secure:
            assert secure.recv(2) == b"ok"

    try:
        await asyncio.to_thread(tls_client)
        assert observed_sni == ["example.test"]
    finally:
        proxy_server.close()
        target_server.close()
        await proxy_server.wait_closed()
        await target_server.wait_closed()


@pytest.mark.asyncio
async def test_parallel_http_responses_are_not_serialized_by_site_governor(monkeypatch):
    from app import egress_proxy
    from app.site_governor import SiteGovernor

    both_requests_accepted = asyncio.Event()
    accepted = 0

    async def target(reader, writer):
        nonlocal accepted
        await reader.readuntil(b"\r\n\r\n")
        accepted += 1
        if accepted == 2:
            both_requests_accepted.set()
        await asyncio.wait_for(both_requests_accepted.wait(), timeout=3)
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    target_server = await asyncio.start_server(target, "127.0.0.1", 0)
    target_port = target_server.sockets[0].getsockname()[1]
    monkeypatch.setattr(
        egress_proxy,
        "site_governor",
        SiteGovernor(minimum_interval_seconds=0),
    )

    async def fake_open_pinned_connection(host, port):
        assert host == "example.com"
        assert port == 80
        reader, writer = await asyncio.open_connection("127.0.0.1", target_port)
        return reader, writer, ipaddress.ip_address("93.184.216.34")

    monkeypatch.setattr(
        egress_proxy,
        "open_pinned_connection",
        fake_open_pinned_connection,
    )
    proxy_server = await asyncio.start_server(
        egress_proxy.handle_client,
        "127.0.0.1",
        0,
    )
    proxy_port = proxy_server.sockets[0].getsockname()[1]
    clients = []
    try:
        responses = []

        async def request(path):
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            clients.append(writer)
            request_bytes = f"GET http://example.com{path} HTTP/1.1\r\n".encode()
            request_bytes += b"Host: example.com\r\n\r\n"
            writer.write(request_bytes)
            await writer.drain()
            responses.append(await asyncio.wait_for(reader.read(), timeout=4))

        await asyncio.gather(request("/segment-1"), request("/segment-2"))
        assert accepted == 2
        assert len(responses) == 2
        assert all(response.startswith(b"HTTP/1.1 200 OK") for response in responses)
    finally:
        for writer in clients:
            writer.close()
            await writer.wait_closed()
        proxy_server.close()
        target_server.close()
        await proxy_server.wait_closed()
        await target_server.wait_closed()
