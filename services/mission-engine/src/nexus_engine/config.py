from __future__ import annotations

import os
import json
import shutil
import tempfile
from datetime import UTC, datetime
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_path: Path
    acp_runner: Path | None
    acp_registry: Path | None
    worker_enabled: bool
    worker_concurrency: int
    profiles_file: Path | None

    @classmethod
    def from_environment(cls) -> "Settings":
        runner = os.getenv("NEXUS_ENGINE_ACP_RUNNER")
        registry = os.getenv("NEXUS_ENGINE_ACP_REGISTRY")
        return cls(
            database_path=Path(
                os.getenv("NEXUS_ENGINE_DATABASE", "var/nexus-engine.db")
            ),
            acp_runner=Path(runner) if runner else None,
            acp_registry=Path(registry) if registry else None,
            worker_enabled=os.getenv("NEXUS_ENGINE_WORKER_ENABLED", "false").lower()
            == "true",
            worker_concurrency=max(
                1, min(8, int(os.getenv("NEXUS_ENGINE_WORKER_CONCURRENCY", "2")))
            ),
            profiles_file=(
                Path(value)
                if (value := os.getenv("NEXUS_ENGINE_PROFILES_FILE"))
                else Path("config/profiles.local.json")
            ),
        )

    def load_profiles(self) -> dict[str, str]:
        if self.profiles_file is None or not self.profiles_file.exists():
            return {}
        payload = json.loads(self.profiles_file.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in payload.items()
        ):
            raise ValueError("profiles file must be a JSON object of string mappings")
        return payload

    def save_profiles(self, profiles: dict[str, str]) -> Path:
        """Persist the registry atomically and keep a dated recovery copy."""
        if self.profiles_file is None:
            raise ValueError("profiles file is not configured")
        path = self.profiles_file
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            backup = path.with_name(f"{path.name}.bak-{stamp}")
            shutil.copy2(path, backup)
        payload = json.dumps(profiles, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", dir=path.parent, text=True
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return path
