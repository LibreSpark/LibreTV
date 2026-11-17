from __future__ import annotations

import ipaddress
import socket
from urllib.parse import unquote, urlsplit


class UnsafeTargetError(ValueError):
    pass


_ALLOWED_PORTS = {80, 443}


def validate_public_http_url(url: str) -> str:
    """Reject unsafe URL forms and hosts that resolve to non-public addresses.

    This is an application-layer guard, not a substitute for network egress
    filtering. DNS can change between this check and the HTTP connection.
    """
    decoded_url = unquote(url)
    if (
        not url
        or url != url.strip()
        or len(url) > 2048
        or any(ord(char) < 32 for char in decoded_url)
    ):
        raise UnsafeTargetError("Target URL is empty, too long or contains control characters.")
    if "\\" in decoded_url:
        raise UnsafeTargetError("Backslashes are not allowed in target URLs.")

    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise UnsafeTargetError("Target URL is malformed.") from exc

    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise UnsafeTargetError("Only absolute public HTTP(S) URLs are allowed.")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeTargetError("Credentials in target URLs are not allowed.")

    expected_port = 443 if parsed.scheme.lower() == "https" else 80
    if port is not None and port not in _ALLOWED_PORTS:
        raise UnsafeTargetError("Only standard HTTP and HTTPS ports are allowed.")
    if port is not None and port != expected_port:
        raise UnsafeTargetError("The URL port does not match its HTTP scheme.")

    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        raise UnsafeTargetError("Localhost targets are not allowed.")

    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            records = socket.getaddrinfo(
                host,
                expected_port,
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise UnsafeTargetError("Target host could not be resolved.") from exc
        addresses = {ipaddress.ip_address(record[4][0].split("%", 1)[0]) for record in records}

    if not addresses or any(not address.is_global for address in addresses):
        raise UnsafeTargetError("Private, local, reserved or non-public targets are not allowed.")
    return url
