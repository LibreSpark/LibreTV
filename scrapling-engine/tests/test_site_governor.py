from __future__ import annotations

import asyncio

import pytest

from app.site_governor import SiteCircuitOpen, SiteGovernor


@pytest.mark.asyncio
async def test_site_governor_serializes_same_host_and_allows_other_hosts() -> None:
    governor = SiteGovernor(minimum_interval_seconds=0)
    active: dict[str, int] = {}
    maximum: dict[str, int] = {}

    async def request(host: str) -> None:
        async with governor.request(host) as lease:
            active[host] = active.get(host, 0) + 1
            maximum[host] = max(maximum.get(host, 0), active[host])
            await asyncio.sleep(0.01)
            active[host] -= 1
            lease.mark_success()

    await asyncio.gather(
        *(request("example.com") for _ in range(5)),
        *(request("other.example") for _ in range(2)),
    )
    assert maximum["example.com"] == 1
    assert maximum["other.example"] == 1


@pytest.mark.asyncio
async def test_site_governor_opens_and_resets_circuit() -> None:
    governor = SiteGovernor(
        minimum_interval_seconds=0,
        failure_threshold=2,
        base_cooldown_seconds=0.1,
        maximum_cooldown_seconds=0.1,
    )
    for _ in range(2):
        async with governor.request("example.com") as lease:
            lease.mark_failure()
    with pytest.raises(SiteCircuitOpen):
        async with governor.request("example.com"):
            pass
    await asyncio.sleep(0.12)
    async with governor.request("example.com") as lease:
        lease.mark_success()
    assert governor.snapshot("example.com")["failures"] == 0
    assert governor.snapshot("example.com")["open_until"] == 0


@pytest.mark.asyncio
async def test_site_governor_applies_per_site_minimum_interval() -> None:
    governor = SiteGovernor(minimum_interval_seconds=0.02)
    starts: list[float] = []

    async def request() -> None:
        async with governor.request("example.com") as lease:
            starts.append(asyncio.get_running_loop().time())
            lease.mark_success()

    await asyncio.gather(request(), request())
    assert len(starts) == 2
    assert max(starts) - min(starts) >= 0.015


def test_record_failure_can_be_applied_after_pacing_lease_is_released() -> None:
    governor = SiteGovernor(
        minimum_interval_seconds=0,
        failure_threshold=1,
        base_cooldown_seconds=0.1,
        maximum_cooldown_seconds=0.1,
    )
    governor.record_failure("example.com")
    assert governor.snapshot("example.com")["failures"] == 1
    assert governor.snapshot("example.com")["open_until"] > 0
