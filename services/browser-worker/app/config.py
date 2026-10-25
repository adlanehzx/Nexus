"""Worker configuration.

Validated at startup: missing required settings prevent boot rather than causing
runtime errors on requests. Sensitive values are never logged — ``describe()``
returns only safe metadata.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BROWSER_WORKER_", extra="ignore")

    #: Service token required for every request.
    auth_token: str = Field(min_length=16)

    # Listen on all container interfaces; real exposition is bounded by Docker.
    host: str = "0.0.0.0"  # noqa: S104
    port: int = 8100
    log_level: str = "INFO"

    #: LLM provider model for browser-use.
    llm_model: str = "claude-sonnet-4-5"
    llm_api_key: str | None = None

    headless: bool = True
    max_sessions: int = 5
    session_ttl_seconds: int = 600
    #: Interval for sweeping expired sessions.
    cleanup_interval_seconds: int = 30
    default_max_steps: int = 15
    default_task_timeout_seconds: int = 180

    #: Testing only: allow private hosts (local test server).
    allow_private_hosts: bool = False

    @field_validator("auth_token")
    @classmethod
    def _reject_placeholder(cls, value: str) -> str:
        if value.strip().lower() in {"changeme", "secret", "token", "x" * len(value)}:
            raise ValueError("BROWSER_WORKER_AUTH_TOKEN must be a secure secret")
        return value

    def describe(self) -> dict[str, object]:
        """Safe view for logging: excludes sensitive secrets."""
        return {
            "host": self.host,
            "port": self.port,
            "headless": self.headless,
            "max_sessions": self.max_sessions,
            "session_ttl_seconds": self.session_ttl_seconds,
            "llm_model": self.llm_model,
            "llm_api_key_present": self.llm_api_key is not None,
            "auth_token_present": True,
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
