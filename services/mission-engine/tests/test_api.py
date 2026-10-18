from __future__ import annotations

from pathlib import Path
import json

from fastapi.testclient import TestClient

from nexus_engine.api import create_app
from nexus_engine.config import Settings


def client(tmp_path: Path) -> TestClient:
    profile_file = tmp_path / "profiles.json"
    profile_file.write_text('{"codex":"profile-codex"}', encoding="utf-8")
    app = create_app(
        Settings(
            database_path=tmp_path / "api.db",
            acp_runner=None,
            acp_registry=None,
            worker_enabled=False,
            worker_concurrency=2,
            profiles_file=profile_file,
            runtime_settings_file=tmp_path / "runtime-settings.json",
        )
    )
    return TestClient(app)


def payload() -> dict:
    return {
        "external_key": "api-demo",
        "title": "API demo",
        "workspace": "/tmp/workspace",
        "defaults": {"profile": "codex"},
        "tasks": [{"key": "one", "instruction": "Do one", "depends_on": []}],
    }


def test_health_and_profiles(tmp_path: Path) -> None:
    with client(tmp_path) as api:
        assert api.get("/v1/health/live").json() == {"status": "ok"}
        assert api.get("/v1/profiles").json() == {"profiles": ["codex"]}


def test_runtime_settings_are_validated_and_persisted(tmp_path: Path) -> None:
    with client(tmp_path) as api:
        settings = api.get("/v1/settings").json()
        settings["max_attempts"] = 5
        settings["quality_review"] = False
        updated = api.put("/v1/settings", json=settings)
        assert updated.status_code == 200
        assert updated.json()["max_attempts"] == 5
        assert api.get("/v1/settings").json()["quality_review"] is False
    stored = json.loads((tmp_path / "runtime-settings.json").read_text(encoding="utf-8"))
    assert stored["max_attempts"] == 5


def test_submit_and_replay(tmp_path: Path) -> None:
    with client(tmp_path) as api:
        first = api.post(
            "/v1/missions", json=payload(), headers={"Idempotency-Key": "api-1"}
        )
        second = api.post(
            "/v1/missions", json=payload(), headers={"Idempotency-Key": "api-1"}
        )
        assert first.status_code == 201
        assert second.status_code == 200
        assert first.json()["mission_id"] == second.json()["mission_id"]
        mission = api.get(f"/v1/missions/{first.json()['mission_id']}")
        assert mission.status_code == 200
        assert mission.json()["tasks"][0]["task_key"] == "one"


def test_agent_registry_discovers_and_persists_native_profile(tmp_path: Path) -> None:
    profile_file = tmp_path / "profiles.json"
    profile_file.write_text('{"codex":"codex"}', encoding="utf-8")
    registry_file = tmp_path / "acp-registry.json"
    registry_file.write_text(
        json.dumps(
            {
                "profiles": {
                    "codex": {"name": "Codex", "command": "/safe/codex", "args": []},
                    "profile-new": {
                        "name": "New Agent",
                        "command": "/safe/new",
                        "args": [],
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    runner = tmp_path / "runner.js"
    runner.write_text("", encoding="utf-8")
    app = create_app(
        Settings(
            database_path=tmp_path / "agents.db",
            acp_runner=runner,
            acp_registry=registry_file,
            worker_enabled=False,
            worker_concurrency=2,
            profiles_file=profile_file,
        )
    )

    with TestClient(app) as api:
        registry = api.get("/v1/agents")
        assert registry.status_code == 200
        assert registry.json()["available"][0]["registered_as"] == "codex"

        added = api.post(
            "/v1/agents",
            json={"key": "new-agent", "agent_profile_id": "profile-new"},
        )
        assert added.status_code == 201
        assert {item["key"] for item in added.json()["configured"]} == {
            "codex",
            "new-agent",
        }

    assert json.loads(profile_file.read_text(encoding="utf-8"))["new-agent"] == "profile-new"
    assert list(tmp_path.glob("profiles.json.bak-*"))


def test_creates_acp_profile_from_safe_template_and_registers_it(tmp_path: Path) -> None:
    profile_file = tmp_path / "profiles.json"
    profile_file.write_text('{"claude":"claude"}', encoding="utf-8")
    registry_file = tmp_path / "acp-registry.json"
    registry_file.write_text(
        '{"profiles":{"claude":{"name":"Claude","command":"/safe/claude-acp",'
        '"args":[],"model":"old-model"}}}',
        encoding="utf-8",
    )
    runner = tmp_path / "runner.js"
    runner.write_text("", encoding="utf-8")
    app = create_app(
        Settings(
            database_path=tmp_path / "create-agent.db",
            acp_runner=runner,
            acp_registry=registry_file,
            worker_enabled=False,
            worker_concurrency=2,
            profiles_file=profile_file,
        )
    )

    with TestClient(app) as api:
        created = api.post(
            "/v1/agents/create",
            json={
                "key": "claude-review",
                "name": "Claude-Review",
                "template_profile_id": "claude",
                "model": "new-model",
            },
        )
        assert created.status_code == 201

    stored = json.loads(registry_file.read_text(encoding="utf-8"))["profiles"]
    assert stored["claude-review"]["model"] == "new-model"
    assert stored["claude-review"]["command"] == "/safe/claude-acp"
    persisted = json.loads(profile_file.read_text(encoding="utf-8"))
    assert persisted["claude-review"] == "claude-review"
