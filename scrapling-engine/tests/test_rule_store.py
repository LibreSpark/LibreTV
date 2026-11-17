from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from app.rule_store import PostgresRuleStore


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_rule_registry_versions_tests_and_requires_human_activation() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresRuleStore(database_url)
    store.initialize()
    workflow_id = "rule_test_" + uuid.uuid4().hex

    try:
        first = store.save_tested_rule(
            page_url="https://93.184.216.34/catalog",
            goal="extract movie titles",
            mode="css",
            selector=".movie-card a.title",
            rationale="Stable title link selector.",
            match_count=3,
            sample_values=["Film A", "Film B", "Film C"],
            workflow_id=workflow_id,
        )
        second = store.save_tested_rule(
            page_url="https://93.184.216.34/catalog?page=2",
            goal="extract movie titles",
            mode="xpath",
            selector="//article[contains(@class, 'movie-card')]//a",
            rationale="Alternative tested selector.",
            match_count=2,
            sample_values=["Film D", "Film E"],
            workflow_id=workflow_id,
        )
        first_rule = store.get_rule(first)
        second_rule = store.get_rule(second)
        assert first_rule is not None and second_rule is not None
        assert first_rule["version"] == 1
        assert second_rule["version"] == 2
        assert first_rule["status"] == "tested"
        assert first_rule["tests"][0]["passed"] is True
        assert first_rule["events"][0]["action"] == "rule_tested"
        assert second_rule["status"] == "tested"
        assert store.set_status(first, "active", "human-reviewer", "Selector reviewed")
        active = store.get_rule(first)
        newer = store.get_rule(second)
        assert active is not None and newer is not None
        assert active["status"] == "active"
        assert [
            rule["rule_id"]
            for rule in store.list_active_for_origin("https://93.184.216.34/catalog")
        ] == [first]
        assert newer["status"] == "tested"
        assert newer["events"][-1]["action"] == "rule_tested"
        assert active["events"][-1]["actor_id"] == "human-reviewer"
        assert not store.set_status("missing-rule", "active", "human-reviewer")
    finally:
        with psycopg.connect(database_url) as db:
            db.execute(
                "DELETE FROM scraping_rules WHERE workflow_id = %s",
                (workflow_id,),
            )


@pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="PostgreSQL integration database is not configured",
)
def test_active_rule_is_auto_disabled_after_three_consecutive_execution_failures() -> None:
    database_url = os.environ["DATABASE_URL"]
    store = PostgresRuleStore(database_url)
    store.initialize()
    workflow_id = "rule_feedback_" + uuid.uuid4().hex

    try:
        rule_id = store.save_tested_rule(
            page_url="https://93.184.216.34/catalog",
            goal="extract movie titles",
            mode="css",
            selector=".movie-card a.title",
            rationale="Tested title selector.",
            match_count=2,
            sample_values=["Film A", "Film B"],
            workflow_id=workflow_id,
        )
        assert store.set_status(rule_id, "active", "human-reviewer", "Approved")

        first = store.record_execution(
            rule_id,
            passed=False,
            match_count=0,
            sample_values=[],
            workflow_id=workflow_id,
            page_url="https://93.184.216.34/catalog?page=1",
            error="no_matches",
        )
        second = store.record_execution(
            rule_id,
            passed=False,
            match_count=0,
            sample_values=[],
            workflow_id=workflow_id,
            page_url="https://93.184.216.34/catalog?page=2",
            error="no_matches",
        )
        assert first["failure_streak"] == 1
        assert first["auto_disabled"] is False
        assert second["failure_streak"] == 2
        assert second["auto_disabled"] is False

        recovered = store.record_execution(
            rule_id,
            passed=True,
            match_count=3,
            sample_values=["Film A", "Film B", "Film C"],
            workflow_id=workflow_id,
            page_url="https://93.184.216.34/catalog?page=3",
        )
        assert recovered["failure_streak"] == 0
        assert recovered["auto_disabled"] is False

        for page in (4, 5):
            feedback = store.record_execution(
                rule_id,
                passed=False,
                match_count=0,
                sample_values=[],
                workflow_id=workflow_id,
                page_url=f"https://93.184.216.34/catalog?page={page}",
                error="selector_mismatch",
            )
            assert feedback["auto_disabled"] is False

        final = store.record_execution(
            rule_id,
            passed=False,
            match_count=0,
            sample_values=[],
            workflow_id=workflow_id,
            page_url="https://93.184.216.34/catalog?page=6",
            error="selector_mismatch",
        )
        assert final["failure_streak"] == 3
        assert final["auto_disabled"] is True
        stored = store.get_rule(rule_id)
        assert stored is not None
        assert stored["status"] == "disabled"
        assert stored["events"][-1]["action"] == "auto_disabled"
    finally:
        with psycopg.connect(database_url) as db:
            db.execute(
                "DELETE FROM scraping_rules WHERE workflow_id = %s",
                (workflow_id,),
            )
