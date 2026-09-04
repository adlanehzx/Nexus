"""Configuration du worker.

Validée au démarrage : une variable manquante empêche le boot, elle ne produit
pas une erreur obscure à la première requête. Aucune valeur sensible n'est
journalisée — ``describe()`` ne rend que les clés.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BROWSER_WORKER_", extra="ignore")

    #: Jeton de service exigé sur chaque appel. Le worker n'est jamais exposé à
    #: Internet, mais on ne compte pas sur la seule topologie réseau.
    auth_token: str = Field(min_length=16)

    # Écoute sur toutes les interfaces du conteneur ; l'exposition réelle est
    # décidée par Docker, et aucun port n'est publié.
    host: str = "0.0.0.0"  # noqa: S104
    port: int = 8100
    log_level: str = "INFO"

    #: Fournisseur LLM de browser-use. Le worker ne lit jamais la clé ailleurs.
    llm_model: str = "claude-sonnet-4-5"
    llm_api_key: str | None = None

    headless: bool = True
    max_sessions: int = 5
    session_ttl_seconds: int = 600
    #: Balayage des sessions expirées.
    cleanup_interval_seconds: int = 30
    default_max_steps: int = 15
    default_task_timeout_seconds: int = 180

    #: Réservé aux tests : autorise les hôtes privés (site de test local).
    allow_private_hosts: bool = False

    @field_validator("auth_token")
    @classmethod
    def _reject_placeholder(cls, value: str) -> str:
        if value.strip().lower() in {"changeme", "secret", "token", "x" * len(value)}:
            raise ValueError("BROWSER_WORKER_AUTH_TOKEN doit être un vrai secret")
        return value

    def describe(self) -> dict[str, object]:
        """Vue sûre à journaliser : jamais de valeur sensible."""
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
