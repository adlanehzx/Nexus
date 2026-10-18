from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable


class AcpError(RuntimeError):
    def __init__(self, message: str, *, category: str = "transport"):
        super().__init__(message)
        self.category = category


class AcpGateway:
    """Run one ACP turn through the audited NEXUS runtime subprocess."""

    def __init__(self, runner: str | Path, registry: str | Path):
        self.runner = Path(runner)
        self.registry = Path(registry)

    def execute(
        self,
        *,
        profile_key: str,
        workspace: str,
        prompt: str,
        timeout_seconds: int,
        heartbeat: Callable[[], None],
    ) -> str:
        if not self.runner.is_file() or not self.registry.is_file():
            raise AcpError("NEXUS ACP runtime is not configured", category="config")
        command = [
            "node",
            str(self.runner),
            "--profile",
            profile_key,
            "--cwd",
            workspace,
            "--registry",
            str(self.registry),
        ]
        environment = dict(os.environ)
        for key in ("LOCAL_BACKEND_API_KEY",):
            environment.pop(key, None)
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=workspace,
            env=environment,
        )
        assert process.stdin is not None
        process.stdin.write(prompt)
        process.stdin.close()
        deadline = time.monotonic() + timeout_seconds
        next_heartbeat = time.monotonic() + 10
        while process.poll() is None:
            current = time.monotonic()
            if current >= deadline:
                self._terminate(process)
                raise AcpError("agent timeout", category="timeout")
            if current >= next_heartbeat:
                heartbeat()
                next_heartbeat = current + 10
            time.sleep(0.25)
        assert process.stdout is not None and process.stderr is not None
        stdout = process.stdout.read(1_000_001)
        stderr = process.stderr.read(16_385)
        if len(stdout) > 1_000_000 or len(stderr) > 16_384:
            raise AcpError("agent output exceeded limit", category="transport")
        if process.returncode != 0:
            category = stderr.strip().splitlines()[-1] if stderr.strip() else "agent_transport"
            allowed = {
                "agent_auth_required": "auth_required",
                "agent_quota_exhausted": "quota_exhausted",
                "agent_rate_limited": "rate_limited",
                "agent_transport": "transport",
            }
            raise AcpError("ACP agent failed", category=allowed.get(category, "transport"))
        try:
            payload = json.loads(stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise AcpError("ACP agent returned invalid JSON") from exc
        response = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(response, str) or not response.strip():
            raise AcpError("ACP agent returned an empty response", category="empty_response")
        return response

    def agent_profiles(self) -> list[dict[str, Any]]:
        profiles = self._profiles()
        return [
            {
                "id": key,
                "name": str(profiles[key].get("name", key)),
                "agent_kind": "acp",
                "revision": None,
                "command": str(profiles[key].get("command", "")),
                "args": [str(value) for value in profiles[key].get("args", [])],
                "model": (
                    str(profiles[key]["model"])
                    if isinstance(profiles[key].get("model"), str)
                    else None
                ),
                "permission_policy": "workspace",
            }
            for key in sorted(profiles)
            if isinstance(key, str) and isinstance(profiles[key], dict)
        ]

    def clone_agent_profile(
        self,
        template_key: str,
        new_key: str,
        name: str,
        model: str | None,
    ) -> None:
        profiles = self._profiles()
        source = profiles.get(template_key)
        if not isinstance(source, dict):
            raise AcpError("unknown ACP template", category="config")
        if new_key in profiles:
            raise AcpError("ACP profile already exists", category="conflict")
        clone = dict(source)
        clone["name"] = name
        if model is not None and model.strip():
            clone["model"] = model.strip()
        profiles[new_key] = clone
        self._save_profiles(profiles)

    def update_agent_profile(
        self,
        profile_key: str,
        *,
        name: str,
        command: str,
        args: list[str],
        model: str | None,
    ) -> None:
        profiles = self._profiles()
        if profile_key not in profiles:
            raise AcpError("unknown ACP profile", category="config")
        clean_command = command.strip()
        if not clean_command or "\x00" in clean_command:
            raise AcpError("invalid ACP command", category="config")
        if any("\x00" in value for value in args):
            raise AcpError("invalid ACP argument", category="config")
        profile: dict[str, Any] = {
            "name": name.strip(),
            "command": clean_command,
            "args": list(args),
        }
        if model is not None and model.strip():
            profile["model"] = model.strip()
        profiles[profile_key] = profile
        self._save_profiles(profiles)

    def _save_profiles(self, profiles: dict[str, dict[str, Any]]) -> None:
        payload = {"profiles": profiles}
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        backup = self.registry.with_name(f"{self.registry.name}.bak-{stamp}")
        shutil.copy2(self.registry, backup)
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{self.registry.name}.", dir=self.registry.parent, text=True
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.registry)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _profiles(self) -> dict[str, dict[str, Any]]:
        payload = json.loads(self.registry.read_text(encoding="utf-8"))
        profiles = payload.get("profiles", {}) if isinstance(payload, dict) else {}
        if not isinstance(profiles, dict) or not all(
            isinstance(key, str) and isinstance(value, dict)
            for key, value in profiles.items()
        ):
            raise AcpError("invalid NEXUS ACP profile registry", category="config")
        return profiles

    @staticmethod
    def _terminate(process: subprocess.Popen[str]) -> None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
