from __future__ import annotations

import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from nexus_engine.acp import AcpError
from nexus_engine.database import Database
from nexus_engine.errors import LeaseLostError
from nexus_engine.repository import MissionRepository
from nexus_engine.worker import Worker


def repository(path: Path) -> MissionRepository:
    result = MissionRepository(Database(path))
    result.register_profile("codex", "fixture-codex")
    return result


def parallel_plan(external_key: str = "durable-parallel") -> dict:
    return {
        "external_key": external_key,
        "title": "Durable parallel mission",
        "workspace": "/tmp/nexus-durable-fixture",
        "defaults": {
            "profile": "codex",
            "max_attempts": 2,
            "retry_delay_seconds": 10,
            "timeout_seconds": 10,
        },
        "tasks": [
            {"key": "left", "instruction": "Run left", "depends_on": []},
            {"key": "right", "instruction": "Run right", "depends_on": []},
            {
                "key": "join",
                "instruction": "Join both results",
                "depends_on": ["left", "right"],
            },
        ],
    }


def test_parallel_tasks_are_leased_together_but_join_remains_ordered(
    tmp_path: Path,
) -> None:
    state = repository(tmp_path / "parallel.db")
    state.submit(parallel_plan(), "parallel-request")

    left = state.acquire("worker-left")
    right = state.acquire("worker-right")

    assert left is not None and left.task_key == "left"
    assert right is not None and right.task_key == "right"
    assert state.acquire("worker-third") is None
    state.succeed(left, "left result")
    assert state.acquire("worker-third") is None
    state.succeed(right, "right result")
    join = state.acquire("worker-third")
    assert join is not None and join.task_key == "join"


def test_restart_reclaims_the_same_attempt_and_completed_work_is_not_repeated(
    tmp_path: Path,
) -> None:
    path = tmp_path / "restart.db"
    first_process = repository(path)
    mission_id, _ = first_process.submit(
        {
            **parallel_plan("restart-once"),
            "tasks": [{"key": "action", "instruction": "Act once", "depends_on": []}],
        },
        "restart-request",
    )
    original = first_process.acquire("worker-before-crash")
    assert original is not None
    with first_process.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE attempts SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (original.attempt_id,),
        )

    restarted = repository(path)
    reclaimed = restarted.acquire("worker-after-crash")
    assert reclaimed is not None
    assert reclaimed.attempt_id == original.attempt_id
    assert reclaimed.conversation_id == original.conversation_id
    restarted.succeed(reclaimed, "externally visible result")

    final_restart = repository(path)
    assert final_restart.acquire("worker-after-success") is None
    assert final_restart.mission(mission_id)["state"] == "succeeded"
    with final_restart.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM attempts").fetchone()[0] == 1


def test_timeout_uses_task_budget_and_retry_backoff_and_limit_are_enforced(
    tmp_path: Path,
) -> None:
    state = repository(tmp_path / "retry.db")
    mission_id, _ = state.submit(
        {
            **parallel_plan("timeout-retry"),
            "tasks": [{"key": "slow", "instruction": "Run", "depends_on": []}],
        },
        "timeout-request",
    )

    class TimeoutGateway:
        calls: list[int] = []

        def execute(self, **values) -> str:  # noqa: ANN003
            self.calls.append(values["timeout_seconds"])
            raise AcpError("agent timeout", category="timeout")

    gateway = TimeoutGateway()
    worker = Worker("timeout-worker", state, gateway)  # type: ignore[arg-type]
    assert worker.run_once() is True
    task = state.mission(mission_id)["tasks"][0]
    assert task["state"] == "retry_wait"
    assert worker.run_once() is False

    with state.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE tasks SET next_attempt_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (task["id"],),
        )
    assert worker.run_once() is True
    assert gateway.calls == [10, 10]
    assert state.mission(mission_id)["state"] == "failed"
    assert worker.run_once() is False


def test_submission_idempotency_survives_restart(tmp_path: Path) -> None:
    path = tmp_path / "idempotency.db"
    first = repository(path)
    mission_id, replayed = first.submit(parallel_plan("idempotent"), "same-request")
    assert replayed is False

    restarted = repository(path)
    replay_id, replayed = restarted.submit(parallel_plan("idempotent"), "same-request")
    assert (replay_id, replayed) == (mission_id, True)
    with restarted.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM missions").fetchone()[0] == 1


@pytest.mark.parametrize(
    ("outcome", "expected_state"),
    [("completed", "succeeded"), ("refused", "failed")],
)
def test_terminal_action_is_not_executed_again_after_restart(
    tmp_path: Path, outcome: str, expected_state: str
) -> None:
    path = tmp_path / f"terminal-{outcome}.db"
    state = repository(path)
    mission_id, _ = state.submit(
        {
            **parallel_plan(f"terminal-{outcome}"),
            "tasks": [{"key": "action", "instruction": "Act", "depends_on": []}],
        },
        f"terminal-{outcome}-request",
    )

    class TerminalGateway:
        calls = 0

        def execute(self, **_values) -> str:  # noqa: ANN003
            self.calls += 1
            if outcome == "refused":
                raise AcpError(
                    "stopped: confirmation_declined",
                    category="confirmation_declined",
                )
            return "completed exactly once"

    gateway = TerminalGateway()
    assert Worker("first-process", state, gateway).run_once() is True  # type: ignore[arg-type]
    restarted = repository(path)
    assert Worker("restarted-process", restarted, gateway).run_once() is False  # type: ignore[arg-type]
    assert gateway.calls == 1
    assert restarted.mission(mission_id)["state"] == expected_state


def test_outbox_lease_is_fenced_reclaimable_and_acknowledged_once(tmp_path: Path) -> None:
    path = tmp_path / "outbox.db"
    first = repository(path)
    first.submit(parallel_plan("outbox"), "outbox-request")
    original = first.claim_outbox("publisher-before-crash", lease_seconds=30)
    assert original is not None and original.event_type == "mission.created"

    restarted = repository(path)
    assert restarted.claim_outbox("publisher-too-early") is None
    with restarted.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE outbox SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (original.id,),
        )
    reclaimed = restarted.claim_outbox("publisher-after-crash")
    assert reclaimed is not None and reclaimed.id == original.id
    assert reclaimed.dedupe_key == original.dedupe_key
    with pytest.raises(LeaseLostError):
        restarted.acknowledge_outbox(original)
    restarted.acknowledge_outbox(reclaimed)

    final_restart = repository(path)
    assert final_restart.claim_outbox("publisher-after-ack") is None
    with final_restart.db.connect() as connection:
        delivered = connection.execute(
            "SELECT delivered_at FROM outbox WHERE id=?", (original.id,)
        ).fetchone()[0]
    assert delivered is not None


def test_outbox_release_preserves_event_for_retry(tmp_path: Path) -> None:
    state = repository(tmp_path / "outbox-release.db")
    state.submit(parallel_plan("outbox-release"), "outbox-release-request")
    claimed = state.claim_outbox("publisher")
    assert claimed is not None

    state.release_outbox(claimed, retry_delay_seconds=0)
    retried = state.claim_outbox("publisher-retry")

    assert retried is not None and retried.id == claimed.id
    assert retried.dedupe_key == claimed.dedupe_key
    with pytest.raises(LeaseLostError):
        state.release_outbox(replace(claimed, lease_token="stale"), 0)


def test_outbox_lease_migration_is_additive_and_preserves_pending_events(
    tmp_path: Path,
) -> None:
    path = tmp_path / "legacy-outbox.db"
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            aggregate_type TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            dedupe_key TEXT NOT NULL UNIQUE,
            payload_json TEXT NOT NULL,
            available_at TEXT NOT NULL,
            delivered_at TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        INSERT INTO outbox(
            aggregate_type,aggregate_id,event_type,dedupe_key,payload_json,
            available_at,created_at
        ) VALUES ('mission','legacy','mission.created','legacy-created','{}',
                  '2000-01-01T00:00:00+00:00','2000-01-01T00:00:00+00:00')
        """
    )
    connection.commit()
    connection.close()

    Database(path).migrate()

    migrated = sqlite3.connect(path)
    columns = {row[1] for row in migrated.execute("PRAGMA table_info(outbox)")}
    assert {"lease_owner", "lease_token", "lease_expires_at"} <= columns
    assert migrated.execute(
        "SELECT dedupe_key FROM outbox WHERE id=1"
    ).fetchone() == ("legacy-created",)
    assert migrated.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    migrated.close()
