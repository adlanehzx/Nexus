from __future__ import annotations

import os
import multiprocessing
import time
from dataclasses import replace

import pytest

from nexus_engine.artifacts import DatabaseArtifactStore
from nexus_engine.errors import LeaseLostError
from nexus_engine.postgres_database import PostgresDatabase, postgres_schema
from nexus_engine.repository import MissionRepository


DATABASE_URL = os.getenv("NEXUS_TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(
    not DATABASE_URL, reason="NEXUS_TEST_POSTGRES_URL is required for PostgreSQL HA tests"
)


def plan() -> dict:
    return {
        "external_key": "postgres-ha-mission",
        "title": "PostgreSQL HA mission",
        "workspace": "/tmp/nexus-ha",
        "defaults": {"profile": "codex", "max_attempts": 2},
        "tasks": [{"key": "effect", "instruction": "act once", "depends_on": []}],
    }


def clean_database(database: PostgresDatabase) -> None:
    with database.transaction(immediate=True) as connection:
        for table in (
            "mission_artifacts",
            "outbox",
            "routing_decisions",
            "agent_events",
            "attempts",
            "task_dependencies",
            "tasks",
            "idempotency_keys",
            "research_runs",
            "schedule_runs",
            "mission_schedules",
            "missions",
            "profile_health",
            "profiles",
        ):
            connection.execute(f"DELETE FROM {table}")


def acquire_and_wait(database_url: str, result: multiprocessing.Queue) -> None:
    repository = MissionRepository(PostgresDatabase(database_url))
    lease = repository.acquire("terminated-node", lease_seconds=1)
    assert lease is not None
    result.put((lease.attempt_id, lease.conversation_id))
    time.sleep(60)


def test_schema_translation_removes_sqlite_only_constructs() -> None:
    schema = postgres_schema()
    assert "PRAGMA" not in schema
    assert "AUTOINCREMENT" not in schema
    assert "json_valid" not in schema
    assert "BIGSERIAL PRIMARY KEY" in schema


def test_two_instances_recover_expired_work_without_double_effect() -> None:
    assert DATABASE_URL is not None
    database = PostgresDatabase(DATABASE_URL)
    MissionRepository(database)
    clean_database(database)
    node_a = MissionRepository(database)
    node_b = MissionRepository(PostgresDatabase(DATABASE_URL))
    node_a.register_profile("codex", "fixture-codex")
    mission_id, _ = node_a.submit(plan(), "postgres-ha-request")

    crashed = node_a.acquire("node-a", lease_seconds=30)
    assert crashed is not None
    with database.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE attempts SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (crashed.attempt_id,),
        )

    recovered = node_b.acquire("node-b", lease_seconds=30)
    assert recovered is not None
    assert recovered.attempt_id == crashed.attempt_id
    assert recovered.conversation_id == crashed.conversation_id
    with pytest.raises(LeaseLostError):
        node_a.succeed(crashed, "stale duplicate")
    node_b.succeed(recovered, "single visible effect")

    assert node_a.acquire("node-a-restarted") is None
    snapshot = node_a.mission(mission_id)
    assert snapshot["state"] == "succeeded"
    assert len(snapshot["tasks"][0]["attempts"]) == 1
    assert snapshot["tasks"][0]["attempts"][0]["state"] == "succeeded"


def test_killed_process_is_recovered_by_another_instance() -> None:
    assert DATABASE_URL is not None
    database = PostgresDatabase(DATABASE_URL)
    MissionRepository(database)
    clean_database(database)
    repository = MissionRepository(database)
    repository.register_profile("codex", "fixture-codex")
    mission_id, _ = repository.submit(plan(), "process-kill-request")

    context = multiprocessing.get_context("spawn")
    result = context.Queue()
    process = context.Process(target=acquire_and_wait, args=(DATABASE_URL, result))
    process.start()
    attempt_id, conversation_id = result.get(timeout=10)
    process.terminate()
    process.join(timeout=10)
    assert process.exitcode is not None and process.exitcode != 0

    time.sleep(1.1)
    recovered = MissionRepository(PostgresDatabase(DATABASE_URL)).acquire("surviving-node")
    assert recovered is not None
    assert (recovered.attempt_id, recovered.conversation_id) == (
        attempt_id,
        conversation_id,
    )
    repository.succeed(recovered, "effect committed once")
    assert repository.mission(mission_id)["state"] == "succeeded"
    with database.connect() as connection:
        attempts = connection.execute(
            "SELECT COUNT(*) FROM attempts WHERE task_id=?", (recovered.task_id,)
        ).fetchone()[0]
    assert attempts == 1


def test_postgres_artifacts_are_visible_across_instances_and_deletions_propagate() -> None:
    assert DATABASE_URL is not None
    database = PostgresDatabase(DATABASE_URL)
    MissionRepository(database)
    clean_database(database)
    repository = MissionRepository(database)
    repository.register_profile("codex", "fixture-codex")
    mission_id, _ = repository.submit(plan(), "artifact-ha-request")
    first = DatabaseArtifactStore(database)
    second = DatabaseArtifactStore(PostgresDatabase(DATABASE_URL))

    first.put(mission_id, "shared.json", "application/json", b'{"safe":true}')
    assert second.get(mission_id, "shared.json").content == b'{"safe":true}'  # type: ignore[union-attr]
    assert second.delete(mission_id, "shared.json") is True
    assert first.get(mission_id, "shared.json") is None
