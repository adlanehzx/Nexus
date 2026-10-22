"""Session and task lifecycle management.

A session = an isolated browser context, owned by a user, with a bounded lifetime.
A task = a discrete execution in that session. Both are kept in memory: losing
the worker drops active sessions (handled as retryable by the orchestrator).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta

from .models import (
    TERMINAL_STATUSES,
    BrowserEvent,
    ErrorCode,
    Intent,
    Session,
    SessionStatus,
    Task,
    TaskError,
    TaskStatus,
    utcnow_iso,
)
from .policies import DomainPolicy, TaskPolicy
from .redaction import redact_text
from .runner import RunSpec, TaskRunner

logger = logging.getLogger(__name__)

_EVENT_TYPES = {
    "started",
    "navigation",
    "thinking",
    "action",
    "progress",
    "result",
    "error",
    "finished",
}


class SessionError(Exception):
    def __init__(self, code: ErrorCode, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class _SessionState:
    def __init__(
        self,
        *,
        session_id: str,
        owner_id: str,
        ttl_seconds: int,
        domains: DomainPolicy,
        headless: bool,
    ) -> None:
        now = datetime.now(UTC)
        self.session_id = session_id
        self.owner_id = owner_id
        self.status = SessionStatus.open
        self.created_at = now
        self.expires_at = now + timedelta(seconds=ttl_seconds)
        self.domains = domains
        self.headless = headless
        self.current_url: str | None = None
        self.active_task_id: str | None = None

    def to_model(self) -> Session:
        return Session(
            sessionId=self.session_id,
            ownerId=self.owner_id,
            status=self.status,
            createdAt=self.created_at.isoformat().replace("+00:00", "Z"),
            expiresAt=self.expires_at.isoformat().replace("+00:00", "Z"),
            currentUrl=self.current_url,
            activeTaskId=self.active_task_id,
        )


class _TaskState:
    def __init__(self, *, task_id: str, session_id: str, intent: Intent, secrets: tuple[str, ...]):
        self.task_id = task_id
        self.session_id = session_id
        self.intent = intent
        self.status = TaskStatus.queued
        self.events: list[BrowserEvent] = []
        self.seq = 0
        self.steps = 0
        self.output: str | None = None
        self.error: TaskError | None = None
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.duration_ms: float | None = None
        self.cancel = asyncio.Event()
        self.handle: asyncio.Task[None] | None = None
        self._monotonic_start = time.monotonic()
        #: Secrets to redact if echoed in events.
        self.secrets = secrets

    def to_model(self, since: int = -1) -> Task:
        return Task(
            taskId=self.task_id,
            sessionId=self.session_id,
            status=self.status,
            intent=self.intent,
            steps=self.steps,
            startedAt=self.started_at,
            finishedAt=self.finished_at,
            durationMs=self.duration_ms,
            output=self.output,
            error=self.error,
            events=[e for e in self.events if e.seq > since],
        )


class SessionManager:
    """Isolated sessions, tasks, background sweeps, cooperative cancellation."""

    def __init__(
        self,
        runner: TaskRunner,
        *,
        max_sessions: int = 5,
        default_ttl_seconds: int = 600,
        allow_private_hosts: bool = False,
    ) -> None:
        self._runner = runner
        self._max_sessions = max_sessions
        self._default_ttl = default_ttl_seconds
        self._allow_private_hosts = allow_private_hosts
        self._sessions: dict[str, _SessionState] = {}
        self._tasks: dict[str, _TaskState] = {}
        self._cleanup: asyncio.Task[None] | None = None

    # ── Sessions ────────────────────────────────────────────────────────────

    def create_session(
        self,
        *,
        owner_id: str,
        allowed_domains: list[str],
        prohibited_domains: list[str],
        ttl_seconds: int | None = None,
        headless: bool = True,
    ) -> Session:
        self._expire_due()

        if len(self._sessions) >= self._max_sessions:
            raise SessionError(
                ErrorCode.session_busy,
                f"Concurrent session limit of {self._max_sessions} reached.",
                status=429,
            )

        state = _SessionState(
            session_id=f"bs_{uuid.uuid4().hex[:16]}",
            owner_id=owner_id,
            ttl_seconds=ttl_seconds or self._default_ttl,
            domains=DomainPolicy(
                allowed=tuple(allowed_domains),
                prohibited=tuple(prohibited_domains),
                allow_private_hosts=self._allow_private_hosts,
            ),
            headless=headless,
        )
        self._sessions[state.session_id] = state
        logger.info("session opened session_id=%s owner=%s", state.session_id, owner_id)
        return state.to_model()

    def get_session(self, session_id: str) -> Session:
        return self._require_session(session_id).to_model()

    async def close_session(self, session_id: str) -> None:
        state = self._sessions.get(session_id)
        if state is None:
            raise SessionError(ErrorCode.session_not_found, "Session not found.", status=404)

        state.status = SessionStatus.closing
        if state.active_task_id:
            await self.cancel_task(state.active_task_id)

        await self._runner.close_session(session_id)
        state.status = SessionStatus.closed
        self._sessions.pop(session_id, None)
        logger.info("session closed session_id=%s", session_id)

    @property
    def open_sessions(self) -> int:
        return sum(1 for s in self._sessions.values() if s.status is SessionStatus.open)

    @property
    def running_tasks(self) -> int:
        return sum(1 for t in self._tasks.values() if t.status is TaskStatus.running)

    # ── Tasks ───────────────────────────────────────────────────────────────

    def start_task(
        self,
        *,
        task_id: str,
        session_id: str,
        instructions: str,
        intent: Intent,
        max_steps: int,
        timeout_seconds: int,
        secrets: dict[str, str],
    ) -> Task:
        session = self._require_session(session_id)

        if session.active_task_id is not None:
            raise SessionError(
                ErrorCode.session_busy,
                "A task is already running in this session.",
                status=409,
            )
        if task_id in self._tasks:
            # Idempotence: duplicate network request does not re-trigger execution.
            return self._tasks[task_id].to_model()

        task = _TaskState(
            task_id=task_id,
            session_id=session_id,
            intent=intent,
            secrets=tuple(secrets.values()),
        )
        self._tasks[task_id] = task
        session.active_task_id = task_id

        spec = RunSpec(
            task_id=task_id,
            session_id=session_id,
            instructions=instructions,
            intent=intent,
            policy=TaskPolicy(intent=intent, domains=session.domains),
            max_steps=max_steps,
            timeout_seconds=timeout_seconds,
            secrets=secrets,
            headless=session.headless,
        )

        task.handle = asyncio.create_task(self._execute(task, session, spec))
        return task.to_model()

    def get_task(self, task_id: str, since: int = -1) -> Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise SessionError(ErrorCode.task_not_found, "Task not found.", status=404)
        return task.to_model(since)

    async def cancel_task(self, task_id: str) -> Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise SessionError(ErrorCode.task_not_found, "Task not found.", status=404)

        if task.status in TERMINAL_STATUSES:
            return task.to_model()

        task.cancel.set()
        if task.handle is not None:
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(task.handle), timeout=5)
            if not task.handle.done():
                task.handle.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task.handle

        if task.status not in TERMINAL_STATUSES:
            self._finish(task, TaskStatus.cancelled)
        return task.to_model()

    # ── Execution ───────────────────────────────────────────────────────────

    async def _execute(self, task: _TaskState, session: _SessionState, spec: RunSpec) -> None:
        task.status = TaskStatus.running
        task.started_at = utcnow_iso()

        def emit(event_type: str, payload: dict) -> None:
            self._emit(task, session, event_type, payload)

        try:
            outcome = await self._runner.run(spec, emit, task.cancel)
        except asyncio.CancelledError:
            self._finish(task, TaskStatus.cancelled)
            raise
        except Exception as exc:
            logger.exception("execution failed task_id=%s", task.task_id)
            task.error = TaskError(
                code="BROWSER_TASK_FAILED",
                message=redact_text(str(exc), task.secrets),
                retryable=True,
            )
            self._finish(task, TaskStatus.failed)
            return
        finally:
            session.active_task_id = None

        task.steps = outcome.steps
        task.output = redact_text(outcome.output, task.secrets) if outcome.output else None

        if outcome.error_code:
            task.error = TaskError(
                code=outcome.error_code,
                message=redact_text(outcome.error_message or "", task.secrets),
                retryable=outcome.retryable,
            )
            emit(
                "error",
                {
                    "code": outcome.error_code,
                    "message": task.error.message,
                    "retryable": outcome.retryable,
                },
            )

        if outcome.output:
            emit("result", {"output": outcome.output, "screenshotRef": None})

        self._finish(task, outcome.status)

    def _emit(
        self, task: _TaskState, session: _SessionState, event_type: str, payload: dict
    ) -> None:
        if event_type not in _EVENT_TYPES:
            logger.warning("unknown event ignored: %s", event_type)
            return

        task.seq += 1
        raw = {
            "type": event_type,
            "taskId": task.task_id,
            "sessionId": task.session_id,
            "seq": task.seq,
            "ts": utcnow_iso(),
            **payload,
        }

        for key, value in raw.items():
            if isinstance(value, str) and key not in {"type", "taskId", "sessionId", "ts"}:
                raw[key] = redact_text(value, task.secrets)

        try:
            from pydantic import TypeAdapter

            event = TypeAdapter(BrowserEvent).validate_python(raw)
        except Exception:
            logger.warning("invalid event ignored: %s", event_type)
            return

        task.events.append(event)
        if event_type == "navigation":
            session.current_url = raw.get("url")

        if event_type == "progress":
            task.steps = max(task.steps, int(raw.get("step", 0)))

    def _finish(self, task: _TaskState, status: TaskStatus) -> None:
        if task.status in TERMINAL_STATUSES:
            return
        task.status = status
        task.finished_at = utcnow_iso()
        task.duration_ms = (time.monotonic() - task._monotonic_start) * 1000

        session = self._sessions.get(task.session_id)
        if session is not None:
            task.seq += 1
            self._emit(
                task,
                session,
                "finished",
                {"status": status.value, "steps": task.steps, "durationMs": task.duration_ms},
            )
        logger.info(
            "task finished task_id=%s session_id=%s status=%s steps=%s duration_ms=%.0f",
            task.task_id,
            task.session_id,
            status.value,
            task.steps,
            task.duration_ms or 0,
        )

    # ── Sweeper ─────────────────────────────────────────────────────────────

    def _require_session(self, session_id: str) -> _SessionState:
        self._expire_due()
        state = self._sessions.get(session_id)
        if state is None:
            raise SessionError(ErrorCode.session_not_found, "Session not found.", status=404)
        if state.status is not SessionStatus.open:
            raise SessionError(ErrorCode.session_expired, "Session closed or expired.", status=410)
        return state

    def _expire_due(self) -> None:
        now = datetime.now(UTC)
        for session_id, state in list(self._sessions.items()):
            if state.expires_at <= now:
                state.status = SessionStatus.expired
                self._sessions.pop(session_id, None)
                logger.info("session expired session_id=%s", session_id)
                asyncio.create_task(self._safe_close(session_id))  # noqa: RUF006

    async def _safe_close(self, session_id: str) -> None:
        with contextlib.suppress(Exception):
            await self._runner.close_session(session_id)

    async def start_cleanup(self, interval_seconds: int) -> None:
        async def loop() -> None:
            while True:
                await asyncio.sleep(interval_seconds)
                self._expire_due()

        self._cleanup = asyncio.create_task(loop())

    async def shutdown(self) -> None:
        """Graceful shutdown: cancels active tasks and closes browser contexts."""
        if self._cleanup is not None:
            self._cleanup.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cleanup

        for task_id in list(self._tasks):
            with contextlib.suppress(Exception):
                await self.cancel_task(task_id)

        for session_id in list(self._sessions):
            with contextlib.suppress(Exception):
                await self.close_session(session_id)
