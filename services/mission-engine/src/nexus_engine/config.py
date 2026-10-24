from __future__ import annotations

import os
import json
import shutil
import tempfile
from datetime import UTC, datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Settings:
    database_path: Path
    acp_runner: Path | None
    acp_registry: Path | None
    worker_enabled: bool
    worker_concurrency: int
    profiles_file: Path | None
    runtime_settings_file: Path | None = None
    #: Base URL of NEXUS API for agent-core tasks. When absent, agent-core tasks
    #: fail with category "config", never falling back to ACP.
    api_base_url: str | None = None
    #: Bridge call timeout including lease.
    api_timeout_seconds: int = 900
    #: Ed25519 public key of API in PEM SPKI format. When present, enables
    #: authentication for incoming mutating requests.
    api_public_key_pem: str | None = None
    #: Durable scheduler dispatcher independent of ACP workers.
    scheduler_enabled: bool = True
    scheduler_poll_seconds: float = 1.0
    #: Shared PostgreSQL URL for multi-node mode. SQLite remains the personal default.
    database_url: str | None = None

    @classmethod
    def from_environment(cls) -> "Settings":
        runner = os.getenv("NEXUS_ENGINE_ACP_RUNNER")
        registry = os.getenv("NEXUS_ENGINE_ACP_REGISTRY")
        return cls(
            database_url=os.getenv("NEXUS_ENGINE_DATABASE_URL") or None,
            api_base_url=os.getenv("NEXUS_ENGINE_API_URL") or None,
            api_public_key_pem=_read_api_public_key(),
            api_timeout_seconds=max(
                30, min(3_600, int(os.getenv("NEXUS_ENGINE_API_TIMEOUT", "900")))
            ),
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
            scheduler_enabled=os.getenv(
                "NEXUS_ENGINE_SCHEDULER_ENABLED", "true"
            ).lower()
            == "true",
            scheduler_poll_seconds=max(
                0.2,
                min(
                    60.0,
                    float(os.getenv("NEXUS_ENGINE_SCHEDULER_POLL_SECONDS", "1")),
                ),
            ),
            profiles_file=(
                Path(value)
                if (value := os.getenv("NEXUS_ENGINE_PROFILES_FILE"))
                else Path("config/profiles.local.json")
            ),
            runtime_settings_file=(
                Path(value)
                if (value := os.getenv("NEXUS_ENGINE_RUNTIME_SETTINGS_FILE"))
                else Path("config/runtime-settings.json")
            ),
        )

    def load_runtime_settings(self) -> dict[str, Any]:
        defaults: dict[str, Any] = {
            "task_timeout_seconds": 1800,
            "max_attempts": 3,
            "retry_delay_seconds": 10,
            "context_budget_chars": 60000,
            "quality_review": True,
            "research_priority": ["antigravity", "claude", "codex"],
            "review_priority": ["claude", "codex", "antigravity"],
            "synthesis_priority": ["claude", "antigravity", "codex"],
        }
        path = self.runtime_settings_file
        if path is None or not path.exists():
            return defaults
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("runtime settings file must be a JSON object")
        return {**defaults, **payload}

    def save_runtime_settings(self, values: dict[str, Any]) -> Path:
        if self.runtime_settings_file is None:
            raise ValueError("runtime settings file is not configured")
        return self._save_json(self.runtime_settings_file, values)

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
        return self._save_json(self.profiles_file, profiles)

    @staticmethod
    def _save_json(path: Path, values: dict[str, Any]) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            backup = path.with_name(f"{path.name}.bak-{stamp}")
            shutil.copy2(path, backup)
        payload = json.dumps(values, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
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


def _read_api_public_key() -> str | None:
    """Reads API public key from file or environment variable.

    File takes precedence over environment variable if both are provided.
    """
    path = os.getenv("NEXUS_ENGINE_API_PUBLIC_KEY_FILE")
    if path:
        return Path(path).read_text(encoding="utf-8")
    inline = os.getenv("NEXUS_ENGINE_API_PUBLIC_KEY")
    if not inline:
        return None
    # Restore escaped newlines if passed inline.
    return inline.replace("\\n", "\n")
