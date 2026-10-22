"""HTTP API for the Browser Worker.

Versioned, authenticated contract, isolated on internal Docker networks.
Routes validate inputs, delegate to `SessionManager`, and serialize responses.
See ``packages/browser-client`` for TypeScript client implementation.
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
    """Construct the FastAPI application.

    `runner` is injectable for unit testing without headless browsers or LLMs.
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
        logger.info("starting browser worker %s", settings.describe())
        _warn_on_stale_action_names()
        await manager.start_cleanup(settings.cleanup_interval_seconds)
        try:
            yield
        finally:
            await manager.shutdown()
            logger.info("browser worker stopped")

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

    # ── Health ──────────────────────────────────────────────────────────────

    @app.get("/v1/health", response_model=Health)
    async def health() -> Health:
        """Unauthenticated readiness and health probe for internal networks."""
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

    # ── Tasks ───────────────────────────────────────────────────────────────

    @app.post("/v1/sessions/{session_id}/tasks", response_model=Task, dependencies=[Depends(auth)])
    async def run_task(session_id: str, body: RunTaskRequest) -> Task:
        if body.sessionId != session_id:
            raise SessionError(
                ErrorCode.invalid_request,
                "Session ID in body does not match URL.",
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
    """Verify that restricted actions still exist in browser-use."""
    try:
        from browser_use import Tools

        registry = getattr(Tools(), "registry", None)
        actions = getattr(getattr(registry, "registry", None), "actions", None)
        available = set(actions) if actions else set()
    except Exception:
        logger.warning("browser-use actions could not be introspected: restrictions not verified")
        return

    if not available:
        return

    stale = verify_action_names(available)
    if stale:
        logger.error("restricted actions not found in browser-use (renamed?): %s", stale)


def build() -> FastAPI:
    """Uvicorn entry point: ``uvicorn app.main:build --factory``."""
    return create_app()
