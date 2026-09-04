"""API HTTP du Browser Worker.

Contrat versionné, authentifié, jamais exposé à Internet. Les routes ne portent
aucune logique : elles valident, délèguent au `SessionManager`, et traduisent les
erreurs. Voir ``packages/browser-client`` côté TypeScript.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse

from .auth import require_token
from .config import Settings, get_settings
from .logging_setup import configure_logging
from .models import (
    PROTOCOL_VERSION,
    CreateSessionRequest,
    ErrorCode,
    ErrorResponse,
    Health,
    RunTaskRequest,
    Session,
    Task,
)
from .policies import verify_action_names
from .runner import BrowserUseRunner, TaskRunner
from .sessions import SessionError, SessionManager

logger = logging.getLogger(__name__)

VERSION = "0.1.0"


def create_app(*, runner: TaskRunner | None = None, settings: Settings | None = None) -> FastAPI:
    """Fabrique l'application.

    `runner` est injectable : les tests exercent l'API complète — routes, auth,
    sessions, politiques, événements — sans navigateur ni modèle. La seule
    frontière remplacée est celle qui l'est réellement.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    active_runner = runner or BrowserUseRunner(
        model=settings.llm_model, api_key=settings.llm_api_key
    )
    manager = SessionManager(
        active_runner,
        max_sessions=settings.max_sessions,
        default_ttl_seconds=settings.session_ttl_seconds,
        allow_private_hosts=settings.allow_private_hosts,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("démarrage du worker %s", settings.describe())
        _warn_on_stale_action_names()
        await manager.start_cleanup(settings.cleanup_interval_seconds)
        try:
            yield
        finally:
            # Arrêt gracieux : tâches annulées, navigateurs fermés. Sans cela,
            # un redéploiement laisserait des Chromium orphelins.
            await manager.shutdown()
            logger.info("worker arrêté")

    app = FastAPI(
        title="NEXUS Browser Worker",
        version=VERSION,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    app.state.manager = manager
    app.state.settings = settings

    def auth(authorization: str | None = Header(default=None)) -> None:
        require_token(authorization, settings)

    @app.exception_handler(SessionError)
    async def _session_error(_: Request, exc: SessionError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=ErrorResponse.model_validate(
                {
                    "error": {
                        "code": exc.code.value,
                        "message": exc.message,
                        "retryable": exc.status >= 500,
                    }
                }
            ).model_dump(),
        )

    # ── Santé ───────────────────────────────────────────────────────────────

    @app.get("/v1/health", response_model=Health)
    async def health() -> Health:
        """Sonde publique du réseau interne : pas d'authentification.

        Elle ne révèle rien d'exploitable et doit rester joignable même quand le
        jeton est mal configuré — sinon le diagnostic devient impossible.
        """
        version = active_runner.backend_version
        return Health(
            status="ok" if version is not None else "degraded",
            version=VERSION,
            protocolVersion=PROTOCOL_VERSION,
            browserUseVersion=version,
            openSessions=manager.open_sessions,
            runningTasks=manager.running_tasks,
        )

    # ── Sessions ────────────────────────────────────────────────────────────

    @app.post("/v1/sessions", response_model=Session, dependencies=[Depends(auth)])
    async def create_session(body: CreateSessionRequest) -> Session:
        return manager.create_session(
            owner_id=body.ownerId,
            allowed_domains=body.allowedDomains,
            prohibited_domains=body.prohibitedDomains,
            ttl_seconds=body.ttlSeconds,
            headless=body.headless,
        )

    @app.get("/v1/sessions/{session_id}", response_model=Session, dependencies=[Depends(auth)])
    async def get_session(session_id: str) -> Session:
        return manager.get_session(session_id)

    @app.delete("/v1/sessions/{session_id}", status_code=204, dependencies=[Depends(auth)])
    async def close_session(session_id: str) -> None:
        await manager.close_session(session_id)

    # ── Tâches ──────────────────────────────────────────────────────────────

    @app.post("/v1/sessions/{session_id}/tasks", response_model=Task, dependencies=[Depends(auth)])
    async def run_task(session_id: str, body: RunTaskRequest) -> Task:
        if body.sessionId != session_id:
            # Incohérence de chemin : un bug d'appelant, pas une session
            # manquante. Le code le dit, plutôt que de brouiller le diagnostic.
            raise SessionError(
                ErrorCode.invalid_request,
                "L'identifiant de session du corps ne correspond pas à l'URL.",
                status=400,
            )
        return manager.start_task(
            task_id=body.taskId,
            session_id=session_id,
            instructions=body.instructions,
            intent=body.intent,
            max_steps=body.maxSteps,
            timeout_seconds=body.timeoutSeconds,
            secrets=body.secrets,
        )

    @app.get("/v1/tasks/{task_id}", response_model=Task, dependencies=[Depends(auth)])
    async def get_task(task_id: str, since: int = Query(default=-1)) -> Task:
        return manager.get_task(task_id, since)

    @app.post("/v1/tasks/{task_id}/cancel", response_model=Task, dependencies=[Depends(auth)])
    async def cancel_task(task_id: str) -> Task:
        return await manager.cancel_task(task_id)

    return app


def _warn_on_stale_action_names() -> None:
    """Vérifie que les actions restreintes existent toujours dans browser-use.

    Une action renommée en amont ferait silencieusement sauter une restriction :
    une tâche `read` pourrait se remettre à cliquer. Mieux vaut un avertissement
    bruyant qu'une permission perdue en silence.
    """
    try:
        from browser_use import Tools

        registry = getattr(Tools(), "registry", None)
        actions = getattr(getattr(registry, "registry", None), "actions", None)
        available = set(actions) if actions else set()
    except Exception:
        logger.warning("actions browser-use non introspectables : restrictions non vérifiées")
        return

    if not available:
        return

    stale = verify_action_names(available)
    if stale:
        logger.error("actions restreintes introuvables dans browser-use (renommées ?) : %s", stale)


def build() -> FastAPI:
    """Point d'entrée uvicorn : ``uvicorn app.main:build --factory``."""
    return create_app()
