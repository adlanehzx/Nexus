from __future__ import annotations

import json
from pathlib import Path

from nexus_engine.database import Database
from nexus_engine.domain import AGENT_CORE_PROFILE, validate_plan
from nexus_engine.repository import MissionRepository


FIXTURE = Path(__file__).parent / "fixtures" / "complete_mission.json"


def scenario() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_complete_mission_fixture_is_executable_and_covers_the_rush_path(
    tmp_path: Path,
) -> None:
    value = scenario()
    plan = validate_plan(value["plan"], {"codex", "claude", AGENT_CORE_PROFILE})
    tasks = {task.key: task for task in plan.tasks}
    events = value["script"]

    assert set(tasks) == {
        "discover",
        "analyze",
        "prepare_action",
        "perform_action",
        "verify",
    }
    assert tasks["discover"].fallback_profiles == ("claude",)
    assert tasks["analyze"].depends_on == tasks["prepare_action"].depends_on == (
        "discover",
    )
    assert tasks["perform_action"].agent_kind == "agent-core"
    assert {event["event"] for event in events} >= {
        "agent_failure",
        "parallel_ready",
        "tool_call",
        "awaiting_confirmation",
        "confirmation_approved",
        "restart_checkpoint",
        "tool_result",
        "mission_succeeded",
    }

    repository = MissionRepository(Database(tmp_path / "acceptance.db"))
    repository.register_profile("codex", "fixture-codex")
    repository.register_profile("claude", "fixture-claude")
    mission_id, replayed = repository.submit(value["plan"], "fixture-request")

    assert replayed is False
    snapshot = repository.mission(mission_id)
    states = {task["task_key"]: task["state"] for task in snapshot["tasks"]}
    assert states == {
        "discover": "ready",
        "analyze": "blocked",
        "prepare_action": "blocked",
        "perform_action": "blocked",
        "verify": "blocked",
    }


def test_complete_mission_fixture_remains_readable_after_database_reopen(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "reopen.db"
    first = MissionRepository(Database(database_path))
    first.register_profile("codex", "fixture-codex")
    first.register_profile("claude", "fixture-claude")
    mission_id, _ = first.submit(scenario()["plan"], "fixture-reopen")

    reopened = MissionRepository(Database(database_path))
    snapshot = reopened.mission(mission_id)

    assert snapshot["external_key"] == "acceptance-complete-mission"
    assert [task["task_key"] for task in snapshot["tasks"]] == [
        "discover",
        "analyze",
        "prepare_action",
        "perform_action",
        "verify",
    ]
