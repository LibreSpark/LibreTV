from __future__ import annotations

import pytest

from app.workflow_worker import WorkflowWorker


@pytest.mark.asyncio
async def test_optional_rule_generation_failure_does_not_fail_workflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = WorkflowWorker("postgresql://unused", "test-worker")

    async def fail(_payload: dict[str, object]) -> dict[str, object]:
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(worker, "_generate_extraction_rule_impl", fail)
    result = await worker._generate_extraction_rule({"_workflow_id": "workflow-test"})

    assert result["rule_status"] == "skipped"
    assert result["test_passed"] is False
    assert result["reason"] == "RuntimeError"


@pytest.mark.asyncio
async def test_optional_rule_generation_propagates_retryable_provider_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.supervisor import RetryableSupervisorError

    worker = WorkflowWorker("postgresql://unused", "test-worker")

    async def fail(_payload: dict[str, object]) -> dict[str, object]:
        raise RetryableSupervisorError("provider temporarily unavailable")

    monkeypatch.setattr(worker, "_generate_extraction_rule_impl", fail)
    with pytest.raises(RetryableSupervisorError):
        await worker._generate_extraction_rule({"_workflow_id": "workflow-test"})
