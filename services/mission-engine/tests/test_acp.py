from __future__ import annotations

import json

from nexus_engine.acp import AcpGateway


def test_lists_secret_free_native_profiles(tmp_path) -> None:
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
