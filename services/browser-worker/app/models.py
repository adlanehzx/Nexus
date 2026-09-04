"""Modèles du contrat HTTP.

Miroir de ``packages/browser-client/src/protocol.ts``. Le fichier
``contract/browser-protocol.json`` est produit depuis les schémas Zod du
backend, et ``tests/test_contract.py`` vérifie que les deux côtés s'accordent :
une divergence casse le build, pas la production.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field

PROTOCOL_VERSION = 1


def utcnow_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class Intent(StrEnum):
    """Intention déclarée d'une tâche.

    Elle porte le niveau de risque côté agent **et** la restriction réellement
    appliquée ici : une tâche ``read`` ne peut pas cliquer, même si le modèle le
    demande. L'intention est une contrainte d'exécution, pas une étiquette.
    """

    read = "read"
    interact = "interact"
    login = "login"
    purchase = "purchase"


class SessionStatus(StrEnum):
    open = "open"
    closing = "closing"
    closed = "closed"
    expired = "expired"


class TaskStatus(StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"
    timeout = "timeout"
    #: Le site exige une action humaine (CAPTCHA, MFA). Jamais contournée.
    needs_human = "needs_human"


TERMINAL_STATUSES = {
    TaskStatus.succeeded,
    TaskStatus.failed,
    TaskStatus.cancelled,
    TaskStatus.timeout,
    TaskStatus.needs_human,
}


# ── Sessions ────────────────────────────────────────────────────────────────


class CreateSessionRequest(BaseModel):
    #: Sépare les navigateurs par utilisateur : aucun état ne fuit entre comptes.
    ownerId: str = Field(min_length=1)
    allowedDomains: list[str] = Field(default_factory=list)
    prohibitedDomains: list[str] = Field(default_factory=list)
    profileId: str | None = None
    headless: bool = True
    ttlSeconds: Annotated[int, Field(gt=0, le=3600)] = 600
    metadata: dict[str, str] = Field(default_factory=dict)


class Session(BaseModel):
    sessionId: str
    ownerId: str
    status: SessionStatus
    createdAt: str
    expiresAt: str
    currentUrl: str | None = None
    activeTaskId: str | None = None


# ── Tâches ──────────────────────────────────────────────────────────────────


class RunTaskRequest(BaseModel):
    taskId: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    instructions: str = Field(min_length=1, max_length=4000)
    intent: Intent
    maxSteps: Annotated[int, Field(gt=0, le=50)] = 15
    timeoutSeconds: Annotated[int, Field(gt=0, le=900)] = 180
    #: Remis à browser-use en ``sensitive_data`` : le modèle voit un marqueur,
    #: jamais la valeur. Jamais journalisé, jamais renvoyé.
    secrets: dict[str, str] = Field(default_factory=dict)
    metadata: dict[str, str] = Field(default_factory=dict)


class _EventBase(BaseModel):
    taskId: str
    sessionId: str
    seq: int
    ts: str = Field(default_factory=utcnow_iso)


class StartedEvent(_EventBase):
    type: Literal["started"] = "started"
    intent: Intent


class NavigationEvent(_EventBase):
    type: Literal["navigation"] = "navigation"
    url: str
    title: str | None = None


class ThinkingEvent(_EventBase):
    type: Literal["thinking"] = "thinking"
    text: str


class ActionEvent(_EventBase):
    type: Literal["action"] = "action"
    action: str
    target: str | None = None


class ProgressEvent(_EventBase):
    type: Literal["progress"] = "progress"
    step: int
    maxSteps: int
    note: str | None = None


class ResultEvent(_EventBase):
    type: Literal["result"] = "result"
    output: str
    screenshotRef: str | None = None


class ErrorEvent(_EventBase):
    type: Literal["error"] = "error"
    code: str
    message: str
    retryable: bool = False


class FinishedEvent(_EventBase):
    type: Literal["finished"] = "finished"
    status: TaskStatus
    steps: int
    durationMs: float


BrowserEvent = Annotated[
    StartedEvent
    | NavigationEvent
    | ThinkingEvent
    | ActionEvent
    | ProgressEvent
    | ResultEvent
    | ErrorEvent
    | FinishedEvent,
    Field(discriminator="type"),
]


class TaskError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class Task(BaseModel):
    taskId: str
    sessionId: str
    status: TaskStatus
    intent: Intent
    steps: int = 0
    startedAt: str | None = None
    finishedAt: str | None = None
    durationMs: float | None = None
    output: str | None = None
    error: TaskError | None = None
    events: list[BrowserEvent] = Field(default_factory=list)


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    protocolVersion: int = PROTOCOL_VERSION
    browserUseVersion: str | None = None
    openSessions: int = 0
    runningTasks: int = 0


class ErrorBody(BaseModel):
    code: str
    message: str
    retryable: bool = False


class ErrorResponse(BaseModel):
    error: ErrorBody


class ErrorCode(StrEnum):
    """Contrat public : ces codes ne changent pas."""

    invalid_request = "BROWSER_INVALID_REQUEST"
    session_not_found = "BROWSER_SESSION_NOT_FOUND"
    session_expired = "BROWSER_SESSION_EXPIRED"
    task_not_found = "BROWSER_TASK_NOT_FOUND"
    session_busy = "BROWSER_SESSION_BUSY"
    domain_blocked = "BROWSER_DOMAIN_BLOCKED"
    intent_forbidden = "BROWSER_INTENT_FORBIDDEN"
    human_required = "BROWSER_HUMAN_INTERVENTION_REQUIRED"
    timeout = "BROWSER_TASK_TIMEOUT"
    cancelled = "BROWSER_TASK_CANCELLED"
    unavailable = "BROWSER_WORKER_UNAVAILABLE"
