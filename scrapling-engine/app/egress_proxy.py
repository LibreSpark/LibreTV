from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import socket
from urllib.parse import urlsplit

from app.site_governor import SiteCircuitOpen, SiteGovernor

site_governor = SiteGovernor(
    minimum_interval_seconds=float(os.environ.get("EGRESS_SITE_MIN_INTERVAL_SECONDS", "1.5")),
    failure_threshold=int(os.environ.get("EGRESS_SITE_FAILURE_THRESHOLD", "4")),
)

logger = logging.getLogger("libretv.egress_proxy")
MAX_HEADER_BYTES = 64 * 1024
CONNECT_TIMEOUT_SECONDS = 10
DNS_TIMEOUT_SECONDS = 8
IDLE_TIMEOUT_SECONDS = 60
MAX_ACTIVE_CONNECTIONS = 64
_active_connections = 0
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class EgressDenied(ValueError):
    pass


class EgressConnectionFailed(EgressDenied):
    pass


def _is_public_address(address: IPAddress) -> bool:
    return address.is_global and not address.is_reserved and not address.is_multicast


async def resolve_public_addresses(
    host: str,
    port: int,
    resolver=None,
) -> list[IPAddress]:
    normalized = host.rstrip(".").lower()
    if not normalized or normalized == "localhost" or normalized.endswith((".localhost", ".local")):
        raise EgressDenied("Local hostnames are not allowed")

    try:
        literal = ipaddress.ip_address(normalized)
        if isinstance(literal, ipaddress.IPv6Address) and literal.ipv4_mapped:
            literal = literal.ipv4_mapped
        addresses = [literal]
    except ValueError:
        loop = asyncio.get_running_loop()
        resolve = resolver or loop.getaddrinfo
        try:
            records = await asyncio.wait_for(
                resolve(normalized, port, type=socket.SOCK_STREAM),
                timeout=DNS_TIMEOUT_SECONDS,
            )
        except (OSError, TimeoutError) as exc:
            raise EgressDenied("Target DNS resolution failed") from exc
        addresses = []
        for record in records:
            raw = record[4][0].split("%", 1)[0]
            address = ipaddress.ip_address(raw)
            if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                address = address.ipv4_mapped
            addresses.append(address)

    if not addresses or any(not _is_public_address(address) for address in addresses):
        raise EgressDenied("Every resolved address must be globally routable")
    return list(dict.fromkeys(addresses))


async def open_pinned_connection(
    host: str,
    port: int,
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, IPAddress]:
    addresses = await resolve_public_addresses(host, port)
    last_error: OSError | None = None
    for address in addresses:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(str(address), port),
                timeout=CONNECT_TIMEOUT_SECONDS,
            )
            return reader, writer, address
        except (OSError, TimeoutError) as exc:
            last_error = exc
    raise EgressConnectionFailed(
        "Could not connect to any validated target address"
    ) from last_error


def _authority(value: str, expected_port: int) -> tuple[str, int]:
    parsed = urlsplit(f"//{value}")
    try:
        port = parsed.port
    except ValueError as exc:
        raise EgressDenied("Malformed proxy authority") from exc
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port != expected_port
    ):
        raise EgressDenied("Only standard public HTTP(S) ports are allowed")
    return parsed.hostname, port


async def _copy_stream(
    source: asyncio.StreamReader,
    destination: asyncio.StreamWriter,
) -> None:
    while True:
        chunk = await asyncio.wait_for(
            source.read(64 * 1024),
            timeout=IDLE_TIMEOUT_SECONDS,
        )
        if not chunk:
            return
        destination.write(chunk)
        await destination.drain()


async def _tunnel(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    target_reader: asyncio.StreamReader,
    target_writer: asyncio.StreamWriter,
) -> None:
    tasks = {
        asyncio.create_task(_copy_stream(client_reader, target_writer)),
        asyncio.create_task(_copy_stream(target_reader, client_writer)),
    }
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for task in done:
        exception = task.exception()
        if exception:
            logger.debug("Proxy tunnel ended: %s", type(exception).__name__)


async def _write_error(writer: asyncio.StreamWriter, status: int, label: str) -> None:
    body = (label + "\n").encode("ascii", errors="replace")
    writer.write(
        f"HTTP/1.1 {status} {label}\r\n"
        "Connection: close\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Content-Type: text/plain\r\n\r\n".encode("ascii")
        + body
    )
    try:
        await writer.drain()
    except OSError:
        pass


async def _handle_connect_upstream(
    authority: str,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    host, port = _authority(authority, 443)
    # Apply per-host pacing to connection establishment only. Holding the
    # governor lease for the lifetime of a TLS tunnel serializes parallel
    # browser connections and can stall segmented 4K playback.
    async with site_governor.request(host) as lease:
        try:
            target_reader, target_writer, pinned_ip = await open_pinned_connection(host, port)
        except EgressConnectionFailed:
            lease.mark_failure()
            raise
        except EgressDenied:
            lease.ignore()
            raise
        except Exception:
            lease.mark_failure()
            raise
        lease.mark_success()

    logger.info("Pinned HTTPS tunnel to %s:%s via %s", host, port, pinned_ip)
    writer.write(b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: LibreTV-Egress\r\n\r\n")
    await writer.drain()
    try:
        await _tunnel(reader, writer, target_reader, target_writer)
    finally:
        target_writer.close()
        try:
            await target_writer.wait_closed()
        except OSError:
            pass


async def _handle_connect(
    authority: str,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    await _handle_connect_upstream(authority, reader, writer)


async def _handle_http_upstream(
    request_line: str,
    header_lines: list[bytes],
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> int | None:
    parts = request_line.split()
    if len(parts) != 3 or parts[0] not in {"GET", "HEAD"}:
        raise EgressDenied("Only GET and HEAD proxy requests are supported")
    method, target, version = parts
    parsed = urlsplit(target)
    try:
        port = parsed.port or 80
    except ValueError as exc:
        raise EgressDenied("Malformed HTTP target") from exc
    if (
        parsed.scheme.lower() != "http"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or port != 80
        or parsed.fragment
    ):
        raise EgressDenied("Only absolute public HTTP URLs on port 80 are supported")
    host = parsed.hostname

    content_length = 0
    forwarded_headers: list[bytes] = []
    for raw in header_lines:
        line = raw.rstrip(b"\r\n")
        if not line:
            continue
        name, separator, value = line.partition(b":")
        if not separator:
            raise EgressDenied("Malformed HTTP header")
        normalized_name = name.strip().lower()
        if normalized_name in {b"transfer-encoding", b"expect"}:
            raise EgressDenied("Streaming request bodies are not supported by this proxy")
        if normalized_name == b"content-length":
            try:
                content_length = int(value.strip())
            except ValueError as exc:
                raise EgressDenied("Malformed Content-Length") from exc
        if normalized_name in {
            b"connection",
            b"proxy-connection",
            b"proxy-authorization",
            b"keep-alive",
            b"host",
        }:
            continue
        forwarded_headers.append(line)
    if content_length != 0:
        raise EgressDenied("Request bodies are not supported by this proxy")

    # Validate the complete request before opening an outbound socket. Invalid
    # headers must not let clients consume pinned target sockets.
    target_reader, target_writer, pinned_ip = await open_pinned_connection(host, port)
    logger.info("Pinned HTTP request to %s:%s via %s", host, port, pinned_ip)

    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    request = [f"{method} {path} {version}".encode("ascii")]
    request.extend(forwarded_headers)
    request.append(f"Host: {parsed.netloc}".encode("ascii"))
    request.append(b"Connection: close")
    response_status_code = None
    try:
        target_writer.write(b"\r\n".join(request) + b"\r\n\r\n")
        await target_writer.drain()
        while True:
            chunk = await asyncio.wait_for(
                target_reader.read(64 * 1024),
                timeout=IDLE_TIMEOUT_SECONDS,
            )
            if not chunk:
                break
            if response_status_code is None:
                status_line = chunk.split(b"\r\n", 1)[0].split()
                if len(status_line) >= 2:
                    try:
                        response_status_code = int(status_line[1])
                    except ValueError:
                        response_status_code = None
            writer.write(chunk)
            await writer.drain()
    finally:
        target_writer.close()
        try:
            await target_writer.wait_closed()
        except OSError:
            pass
    return response_status_code


async def _handle_http(
    request_line: str,
    header_lines: list[bytes],
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    parts = request_line.split()
    if len(parts) != 3 or parts[0] not in {"GET", "HEAD"}:
        await _handle_http_upstream(request_line, header_lines, reader, writer)
        return
    try:
        host = urlsplit(parts[1]).hostname
    except ValueError:
        host = None
    if not host:
        await _handle_http_upstream(request_line, header_lines, reader, writer)
        return
    async with site_governor.request(host) as lease:
        try:
            status = await _handle_http_upstream(request_line, header_lines, reader, writer)
        except EgressConnectionFailed:
            lease.mark_failure()
            raise
        except EgressDenied:
            lease.ignore()
            raise
        except Exception:
            lease.mark_failure()
            raise
        if status == 429 or status is not None and status >= 500:
            lease.mark_failure()
        else:
            lease.mark_success()


async def handle_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    global _active_connections
    if _active_connections >= MAX_ACTIVE_CONNECTIONS:
        await _write_error(writer, 503, "Service Unavailable")
        writer.close()
        return
    _active_connections += 1
    try:
        header = await asyncio.wait_for(
            reader.readuntil(b"\r\n\r\n"),
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
        if len(header) > MAX_HEADER_BYTES:
            raise EgressDenied("Proxy request headers are too large")
        lines = header.split(b"\r\n")
        try:
            request_line = lines[0].decode("ascii")
        except UnicodeDecodeError as exc:
            raise EgressDenied("Invalid proxy request line") from exc
        parts = request_line.split()
        if len(parts) != 3:
            raise EgressDenied("Malformed proxy request line")
        if parts[0].upper() == "CONNECT":
            await _handle_connect(parts[1], reader, writer)
        else:
            await _handle_http(request_line, lines[1:-2], reader, writer)
    except SiteCircuitOpen:
        await _write_error(writer, 503, "Service Unavailable")
        logger.info("Egress circuit is open for target site")
    except EgressDenied as exc:
        await _write_error(writer, 403, "Forbidden")
        logger.info("Denied egress request: %s", str(exc))
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
        await _write_error(writer, 400, "Bad Request")
    except Exception as exc:
        logger.warning("Egress proxy request failed: %s", type(exc).__name__)
        await _write_error(writer, 502, "Bad Gateway")
    finally:
        _active_connections -= 1
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass


async def main() -> None:
    host = os.environ.get("EGRESS_PROXY_HOST", "0.0.0.0")
    port = int(os.environ.get("EGRESS_PROXY_PORT", "8080"))
    server = await asyncio.start_server(
        handle_client,
        host,
        port,
        limit=MAX_HEADER_BYTES,
        backlog=128,
    )
    logger.info("Validated egress proxy listening on %s:%s", host, port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    asyncio.run(main())
