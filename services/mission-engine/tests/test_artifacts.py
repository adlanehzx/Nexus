from __future__ import annotations

from pathlib import Path

import pytest

from nexus_engine.artifacts import DatabaseArtifactStore
from nexus_engine.database import Database
from nexus_engine.repository import MissionRepository


def test_database_artifact_store_survives_restart_and_deletes_at_storage_level(
    tmp_path: Path,
) -> None:
    path = tmp_path / "artifacts.db"
    database = Database(path)
    repository = MissionRepository(database)
    repository.register_profile("codex", "fixture-codex")
    mission_id, _ = repository.submit(
        {
            "external_key": "artifact-mission",
            "title": "Artifact mission",
            "workspace": str(tmp_path),
            "defaults": {"profile": "codex"},
            "tasks": [{"key": "work", "instruction": "work", "depends_on": []}],
        },
        "artifact-request",
    )

    first = DatabaseArtifactStore(database, max_bytes=32)
    saved = first.put(mission_id, "result.txt", "text/plain", b"durable result")
    assert saved.sha256 == "603e1cb41aa935f04257152ba637eac19bc904545fc537c0b629d4e6172e776b"

    restarted = DatabaseArtifactStore(Database(path), max_bytes=32)
    loaded = restarted.get(mission_id, "result.txt")
    assert loaded is not None and loaded.content == b"durable result"
    assert restarted.delete(mission_id, "result.txt") is True
    assert restarted.get(mission_id, "result.txt") is None

    with Database(path).connect() as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM mission_artifacts WHERE mission_id=?", (mission_id,)
        ).fetchone()[0]
    assert count == 0


def test_database_artifact_store_rejects_unsafe_names_and_oversized_content(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "limits.db")
    MissionRepository(database)
    store = DatabaseArtifactStore(database, max_bytes=4)
    with pytest.raises(ValueError, match="unsafe"):
        store.put("missing", "../secret", "text/plain", b"x")
    with pytest.raises(ValueError, match="size"):
        store.put("missing", "safe.txt", "text/plain", b"12345")
