"""Fixtures partagées.

Le `FakeRunner` remplace la **seule** vraie frontière externe : le navigateur et
le modèle. Tout le reste — routes, authentification, sessions, politiques,
événements, annulation, rédaction — s'exécute réellement.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import TaskStatus
from app.runner import Emit, RunOutcome, RunSpec

TOKEN = "jeton-de-test-suffisamment-long"


class FakeRunner:
    """Runner scriptable : il joue une séquence d'événements puis un résultat."""

    def __init__(self) -> None:
        self.outcome = RunOutcome(status=TaskStatus.succeeded, output="42 euros", steps=2)
        self.events: list[tuple[str, dict]] = [
            ("navigation", {"url": "https://exemple.test/vols", "title": "Vols"}),
            ("progress", {"step": 1, "maxSteps": 15, "note": None}),
            ("action", {"action": "extract_content", "target": "prix"}),
        ]
        self.calls: list[RunSpec] = []
        self.closed: list[str] = []
        self.delay = 0.0
        self.raise_error: Exception | None = None
        self.wait_for_cancel = False

    @property
    def backend_version(self) -> str | None:
        return "0.13.8-fake"

    async def run(self, spec: RunSpec, emit: Emit, cancel: asyncio.Event) -> RunOutcome:
        self.calls.append(spec)
        emit("started", {"intent": spec.intent.value})

        if self.raise_error is not None:
            raise self.raise_error

        for event_type, payload in self.events:
            emit(event_type, payload)

        if self.wait_for_cancel:
            # Simule une tâche longue : elle rend la main quand on l'annule.
            await cancel.wait()
            return RunOutcome(status=TaskStatus.cancelled, steps=1)

        if self.delay:
            await asyncio.sleep(self.delay)

        return self.outcome

    async def close_session(self, session_id: str) -> None:
        self.closed.append(session_id)


@pytest.fixture
def runner() -> FakeRunner:
    return FakeRunner()


@pytest.fixture
def settings() -> Settings:
    return Settings(
        auth_token=TOKEN,
        max_sessions=3,
        session_ttl_seconds=600,
        allow_private_hosts=True,
        log_level="WARNING",
    )


@pytest.fixture
def client(runner: FakeRunner, settings: Settings) -> Iterator[TestClient]:
    app = create_app(runner=runner, settings=settings)
    with TestClient(app) as test_client:
        test_client.headers.update({"authorization": f"Bearer {TOKEN}"})
        yield test_client


def open_session(client: TestClient, **overrides) -> str:
    body = {"ownerId": "user-1", **overrides}
    response = client.post("/v1/sessions", json=body)
    assert response.status_code == 200, response.text
    return response.json()["sessionId"]


def run_and_wait(client: TestClient, session_id: str, **overrides) -> dict:
    body = {
        "taskId": overrides.pop("taskId", "task-1"),
        "sessionId": session_id,
        "instructions": overrides.pop("instructions", "Trouve le prix du billet"),
        "intent": overrides.pop("intent", "read"),
        **overrides,
    }
    response = client.post(f"/v1/sessions/{session_id}/tasks", json=body)
    assert response.status_code == 200, response.text

    task_id = response.json()["taskId"]
    for _ in range(200):
        current = client.get(f"/v1/tasks/{task_id}").json()
        if current["status"] not in {"queued", "running"}:
            return current
    raise AssertionError("la tâche ne s'est jamais terminée")
