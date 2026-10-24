from __future__ import annotations

import base64
import hashlib
import re
import uuid
from dataclasses import dataclass
from typing import Protocol

from nexus_engine.database import Database
from nexus_engine.repository import timestamp


_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


@dataclass(frozen=True)
class Artifact:
    id: str
    mission_id: str
    name: str
    mime_type: str
    content: bytes
    sha256: str
    created_at: str


class ArtifactStore(Protocol):
    def put(self, mission_id: str, name: str, mime_type: str, content: bytes) -> Artifact: ...

    def get(self, mission_id: str, name: str) -> Artifact | None: ...

    def delete(self, mission_id: str, name: str) -> bool: ...


class DatabaseArtifactStore:
    """Artifact store shared by SQLite personal mode and PostgreSQL HA mode."""

    def __init__(self, database: Database, *, max_bytes: int = 16 * 1024 * 1024):
        if max_bytes < 1:
            raise ValueError("artifact size limit must be positive")
        self.database = database
        self.max_bytes = max_bytes

    def put(self, mission_id: str, name: str, mime_type: str, content: bytes) -> Artifact:
        if not _SAFE_NAME.fullmatch(name):
            raise ValueError("artifact name contains unsafe characters")
        if not mime_type or len(mime_type) > 128:
            raise ValueError("artifact MIME type is invalid")
        if len(content) > self.max_bytes:
            raise ValueError("artifact exceeds configured size limit")
        artifact = Artifact(
            id=str(uuid.uuid4()),
            mission_id=mission_id,
            name=name,
            mime_type=mime_type,
            content=bytes(content),
            sha256=hashlib.sha256(content).hexdigest(),
            created_at=timestamp(),
        )
        encoded = base64.b64encode(content).decode("ascii")
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                """
                INSERT INTO mission_artifacts(
                    id,mission_id,name,mime_type,content_base64,size_bytes,sha256,created_at
                ) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(mission_id,name) DO UPDATE SET
                    id=excluded.id,mime_type=excluded.mime_type,
                    content_base64=excluded.content_base64,size_bytes=excluded.size_bytes,
                    sha256=excluded.sha256,created_at=excluded.created_at
                """,
                (
                    artifact.id,
                    mission_id,
                    name,
                    mime_type,
                    encoded,
                    len(content),
                    artifact.sha256,
                    artifact.created_at,
                ),
            )
        return artifact

    def get(self, mission_id: str, name: str) -> Artifact | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id,mission_id,name,mime_type,content_base64,sha256,created_at
                FROM mission_artifacts WHERE mission_id=? AND name=?
                """,
                (mission_id, name),
            ).fetchone()
        if row is None:
            return None
        return Artifact(
            id=str(row["id"]),
            mission_id=str(row["mission_id"]),
            name=str(row["name"]),
            mime_type=str(row["mime_type"]),
            content=base64.b64decode(str(row["content_base64"]), validate=True),
            sha256=str(row["sha256"]),
            created_at=str(row["created_at"]),
        )

    def delete(self, mission_id: str, name: str) -> bool:
        with self.database.transaction(immediate=True) as connection:
            deleted = connection.execute(
                "DELETE FROM mission_artifacts WHERE mission_id=? AND name=?",
                (mission_id, name),
            ).rowcount
        return deleted == 1
