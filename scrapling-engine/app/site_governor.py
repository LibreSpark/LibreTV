from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field


class SiteCircuitOpen(RuntimeError):
    pass


@dataclass
class _HostState:
    gate: asyncio.Lock = field(default_factory=asyncio.Lock)
    next_allowed_at: float = 0.0
    open_until: float = 0.0
    failures: int = 0
    touched_at: float = 0.0


class SiteLease:
    def __init__(self) -> None:
        self.success = False
        self.failed = False
        self.ignored = False

    def mark_success(self) -> None:
        self.success = True

    def mark_failure(self) -> None:
        self.failed = True
        self.success = False

    def ignore(self) -> None:
        self.ignored = True


class SiteGovernor:
    def __init__(
        self,
        *,
        minimum_interval_seconds: float = 1.5,
        failure_threshold: int = 4,
        base_cooldown_seconds: float = 30.0,
        maximum_cooldown_seconds: float = 600.0,
        maximum_hosts: int = 10_000,
    ) -> None:
        self.minimum_interval_seconds = max(0.0, minimum_interval_seconds)
        self.failure_threshold = max(1, failure_threshold)
        self.base_cooldown_seconds = max(0.1, base_cooldown_seconds)
        self.maximum_cooldown_seconds = max(
            self.base_cooldown_seconds,
            maximum_cooldown_seconds,
        )
        self.maximum_hosts = max(100, maximum_hosts)
        self._hosts: OrderedDict[str, _HostState] = OrderedDict()

    def _state(self, host: str, now: float) -> _HostState:
        key = host.rstrip(".").lower()
        state = self._hosts.get(key)
        if state is None:
            state = _HostState(touched_at=now)
            self._hosts[key] = state
        else:
            state.touched_at = now
            self._hosts.move_to_end(key)
        while len(self._hosts) > self.maximum_hosts:
            removable = next(
                (
                    candidate
                    for candidate, item in self._hosts.items()
                    if not item.gate.locked() and item.open_until <= now
                ),
                None,
            )
            if removable is None:
                break
            del self._hosts[removable]
        return state

    @asynccontextmanager
    async def request(self, host: str) -> AsyncIterator[SiteLease]:
        loop = asyncio.get_running_loop()
        state = self._state(host, loop.time())
        await state.gate.acquire()
        lease = SiteLease()
        try:
            now = loop.time()
            if state.open_until > now:
                raise SiteCircuitOpen("The target site's circuit breaker is open.")
            delay = state.next_allowed_at - now
            if delay > 0:
                await asyncio.sleep(delay)
            now = loop.time()
            if state.open_until > now:
                raise SiteCircuitOpen("The target site's circuit breaker is open.")
            state.next_allowed_at = now + self.minimum_interval_seconds
            yield lease
        except BaseException:
            if lease.failed:
                self._record_failure(state, loop.time())
            elif lease.success:
                self._record_success(state)
            raise
        else:
            if lease.failed:
                self._record_failure(state, loop.time())
            elif lease.success:
                self._record_success(state)
        finally:
            state.touched_at = loop.time()
            state.gate.release()

    def record_failure(self, host: str) -> None:
        """Record a response failure after releasing the per-host pacing lease."""
        now = time.monotonic()
        state = self._state(host, now)
        self._record_failure(state, now)

    def _record_failure(self, state: _HostState, now: float) -> None:
        state.failures += 1
        if state.failures >= self.failure_threshold:
            exponent = min(state.failures - self.failure_threshold, 20)
            cooldown = min(
                self.maximum_cooldown_seconds,
                self.base_cooldown_seconds * (2**exponent),
            )
            state.open_until = now + cooldown

    @staticmethod
    def _record_success(state: _HostState) -> None:
        state.failures = 0
        state.open_until = 0.0

    def snapshot(self, host: str) -> dict[str, float | int]:
        state = self._hosts.get(host.rstrip(".").lower())
        if state is None:
            return {"failures": 0, "open_until": 0.0, "next_allowed_at": 0.0}
        return {
            "failures": state.failures,
            "open_until": state.open_until,
            "next_allowed_at": state.next_allowed_at,
        }
