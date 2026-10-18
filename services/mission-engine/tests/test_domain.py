from __future__ import annotations

import pytest

from nexus_engine.domain import validate_plan
from nexus_engine.errors import ValidationError


def plan() -> dict:
    return {
        "external_key": "demo",
        "title": "Demo",
        "workspace": "/tmp/workspace",
        "defaults": {"profile": "codex"},
        "tasks": [
            {"key": "research", "instruction": "Research", "depends_on": []},
            {
                "key": "review",
                "profile": "claude",
                "instruction": "Review",
                "depends_on": ["research"],
            },
        ],
    }


def test_valid_plan() -> None:
    validated = validate_plan(plan(), {"codex", "claude"})
    assert [task.key for task in validated.tasks] == ["research", "review"]
    assert len(validated.content_hash) == 64


def test_unknown_profile_is_rejected() -> None:
    value = plan()
    value["tasks"][1]["profile"] = "unknown"
    with pytest.raises(ValidationError, match="unknown or disabled profile"):
        validate_plan(value, {"codex", "claude"})


def test_cycle_is_rejected() -> None:
    value = plan()
    value["tasks"][0]["depends_on"] = ["review"]
    with pytest.raises(ValidationError, match="cycle"):
        validate_plan(value, {"codex", "claude"})


def test_missing_dependency_is_rejected() -> None:
    value = plan()
    value["tasks"][1]["depends_on"] = ["absent"]
    with pytest.raises(ValidationError, match="missing dependencies"):
        validate_plan(value, {"codex", "claude"})


def test_duplicate_dependency_is_rejected() -> None:
    value = plan()
    value["tasks"][1]["depends_on"] = ["research", "research"]
    with pytest.raises(ValidationError, match="duplicate dependencies"):
        validate_plan(value, {"codex", "claude"})


def test_unknown_task_field_is_rejected() -> None:
    value = plan()
    value["tasks"][0]["surprise"] = True
    with pytest.raises(ValidationError, match="unknown fields"):
        validate_plan(value, {"codex", "claude"})
