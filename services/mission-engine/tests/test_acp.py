from __future__ import annotations

import json

from nexus_engine.acp import AcpGateway


def test_lists_configurable_native_profiles_without_credentials(tmp_path) -> None:
    registry = tmp_path / "profiles.json"
    registry.write_text(
        json.dumps(
            {
                "profiles": {
                    "claude": {
                        "name": "Claude",
                        "command": "/safe/claude",
                        "args": [],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    gateway = AcpGateway(tmp_path / "runner.js", registry)

    assert gateway.agent_profiles() == [
        {
            "id": "claude",
            "name": "Claude",
            "agent_kind": "acp",
            "revision": None,
            "command": "/safe/claude",
            "args": [],
            "model": None,
            "system_prompt": "",
            "reasoning_effort": None,
            "additional_dirs": [],
            "config_options": {},
            "permission_policy": "workspace",
        }
    ]


def test_clone_profile_is_atomic_and_keeps_backup(tmp_path) -> None:
    registry = tmp_path / "profiles.json"
    registry.write_text(
        '{"profiles":{"claude":{"command":"/safe/claude","args":[]}}}',
        encoding="utf-8",
    )
    gateway = AcpGateway(tmp_path / "runner.js", registry)

    gateway.clone_agent_profile("claude", "reviewer", "Reviewer", "model-2")

    payload = json.loads(registry.read_text(encoding="utf-8"))
    assert payload["profiles"]["reviewer"] == {
        "args": [],
        "command": "/safe/claude",
        "model": "model-2",
        "name": "Reviewer",
    }
    assert list(tmp_path.glob("profiles.json.bak-*"))


def test_update_profile_is_atomic_and_preserves_no_secret_fields(tmp_path) -> None:
    registry = tmp_path / "profiles.json"
    registry.write_text(
        '{"profiles":{"claude":{"name":"Claude","command":"/old","args":[]}}}',
        encoding="utf-8",
    )
    gateway = AcpGateway(tmp_path / "runner.js", registry)

    gateway.update_agent_profile(
        "claude",
        name="Claude Review",
        command="/safe/claude",
        args=["--mode", "review"],
        model="opus",
        system_prompt="Always verify facts.",
        reasoning_effort="high",
        additional_dirs=["/srv/nexus-shared"],
        config_options={"approval_mode": "strict"},
    )

    stored = json.loads(registry.read_text(encoding="utf-8"))["profiles"]["claude"]
    assert stored == {
        "name": "Claude Review",
        "command": "/safe/claude",
        "args": ["--mode", "review"],
        "model": "opus",
        "system_prompt": "Always verify facts.",
        "reasoning_effort": "high",
        "additional_dirs": ["/srv/nexus-shared"],
        "config_options": {"approval_mode": "strict"},
    }
    assert list(tmp_path.glob("profiles.json.bak-*"))
