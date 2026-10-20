from __future__ import annotations

import json
import urllib.error
from io import BytesIO

import pytest

from nexus_engine.acp import AcpError
from nexus_engine.agent_core import AgentCoreGateway, validated_base_url
from nexus_engine.database import Database
from nexus_engine.errors import ValidationError
from nexus_engine.repository import MissionRepository
from nexus_engine.worker import Worker

"""Pont Mission Engine → Agent Core.

Ce que ces tests protègent, dans l'ordre d'importance : qu'une tâche Agent Core
ne puisse pas partir sans propriétaire signé, qu'elle ne bascule jamais sur un
agent ACP par repli, et que l'assertion ne se retrouve ni dans la définition de
la mission ni dans un message d'erreur.
"""


class _Response:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_: object) -> None:
        return None


def _gateway(payload: dict, captured: list | None = None) -> AgentCoreGateway:
    def opener(request, timeout):  # noqa: ANN001, ANN202
        if captured is not None:
            captured.append(request)
        return _Response(payload)

    return AgentCoreGateway("http://127.0.0.1:3000", opener=opener)


def _run_payload(response: str = "done", conversation: str = "conv-1") -> dict:
    return {
        "data": {
            "runId": "run-1",
            "conversationId": conversation,
            "status": "completed",
            "response": response,
            "confirmation": None,
        }
    }


def _agent_core_mission(repository: MissionRepository, *, owner: bool = True) -> str:
    spec = {
        "external_key": "bridge-demo",
        "title": "Bridge demo",
        "workspace": "/tmp/workspace",
        "tasks": [
            {
                "key": "delegated",
                "agent_kind": "agent-core",
                "instruction": "Range mes mails",
                "depends_on": [],
            }
        ],
    }
    if owner:
        spec["owner"] = {"user_id": "user-1", "assertion": "signed-assertion"}
    mission_id, _ = repository.submit(spec, f"bridge-{owner}")
    return mission_id


def test_bridge_sends_the_assertion_and_the_mission_scope() -> None:
    captured: list = []
    gateway = _gateway(_run_payload(), captured)

    response, conversation = gateway.execute(
        mission_external_key="bridge-demo",
        task_key="delegated",
        instruction="Range mes mails",
        assertion="signed-assertion",
        conversation_id=None,
        timeout_seconds=120,
        heartbeat=lambda: None,
    )

    assert (response, conversation) == ("done", "conv-1")
    request = captured[0]
    assert request.full_url.endswith("/api/v1/agent-core/mission-runs")
    assert request.get_header("Authorization") == "Bearer signed-assertion"
    body = json.loads(request.data.decode())
    # La portée voyage avec l'appel : l'API refuse de travailler sur une autre
    # mission que celle inscrite dans l'assertion.
    assert body["missionExternalKey"] == "bridge-demo"
    assert "conversationId" not in body


def test_bridge_reuses_a_known_conversation() -> None:
    captured: list = []
    gateway = _gateway(_run_payload(conversation="conv-1"), captured)

    gateway.execute(
        mission_external_key="bridge-demo",
        task_key="delegated",
        instruction="Suite",
        assertion="signed-assertion",
        conversation_id="conv-1",
        timeout_seconds=120,
        heartbeat=lambda: None,
    )

    assert json.loads(captured[0].data.decode())["conversationId"] == "conv-1"


def test_bridge_refuses_to_run_without_an_assertion() -> None:
    with pytest.raises(AcpError) as error:
        _gateway(_run_payload()).execute(
            mission_external_key="bridge-demo",
            task_key="delegated",
            instruction="Range mes mails",
            assertion=None,
            conversation_id=None,
            timeout_seconds=120,
            heartbeat=lambda: None,
        )

    assert error.value.category == "auth_required"


def test_bridge_reports_a_missing_configuration_instead_of_calling() -> None:
    with pytest.raises(AcpError) as error:
        AgentCoreGateway(None).execute(
            mission_external_key="bridge-demo",
            task_key="delegated",
            instruction="Range mes mails",
            assertion="signed-assertion",
            conversation_id=None,
            timeout_seconds=120,
            heartbeat=lambda: None,
        )

    assert error.value.category == "config"


def test_bridge_treats_a_pending_confirmation_as_a_distinct_outcome() -> None:
    payload = _run_payload()
    payload["data"]["response"] = None
    payload["data"]["confirmation"] = {
        "id": "confirm-1",
        "toolName": "mail.send",
        "riskLevel": "high",
        "expiresAt": "2026-10-20T12:00:00.000Z",
    }

    with pytest.raises(AcpError) as error:
        _gateway(payload).execute(
            mission_external_key="bridge-demo",
            task_key="delegated",
            instruction="Envoie un message",
            assertion="signed-assertion",
            conversation_id=None,
            timeout_seconds=120,
            heartbeat=lambda: None,
        )

    # Une confirmation en attente n'est pas un échec de transport : la catégorie
    # doit le dire, sinon la tâche serait retentée et rouvrirait une
    # confirmation à chaque tentative.
    assert error.value.category == "confirmation_required"


@pytest.mark.parametrize(
    ("status", "category"),
    [
        (401, "auth_required"),
        (403, "auth_required"),
        (404, "config"),
        (429, "rate_limited"),
        # Notre propre API indisponible n'est pas un quota épuisé : la tâche doit
        # réessayer, pas attendre une réinitialisation qui n'arrivera jamais.
        (503, "transport"),
        (500, "transport"),
    ],
)
def test_bridge_maps_http_refusals_onto_known_categories(status: int, category: str) -> None:
    def opener(request, timeout):  # noqa: ANN001, ANN202
        raise urllib.error.HTTPError(
            request.full_url, status, "refused", {}, BytesIO(b"{}")
        )

    gateway = AgentCoreGateway("http://127.0.0.1:3000", opener=opener)
    with pytest.raises(AcpError) as error:
        gateway.execute(
            mission_external_key="bridge-demo",
            task_key="delegated",
            instruction="Range mes mails",
            assertion="signed-assertion",
            conversation_id=None,
            timeout_seconds=120,
            heartbeat=lambda: None,
        )

    assert error.value.category == category


def test_base_url_refuses_plain_http_off_the_loopback() -> None:
    assert validated_base_url(None) is None
    assert validated_base_url("https://nexus.example") == "https://nexus.example"
    assert validated_base_url("http://127.0.0.1:3000") == "http://127.0.0.1:3000"
    with pytest.raises(ValueError):
        validated_base_url("http://nexus.example")


def test_agent_core_task_requires_a_signed_owner(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")

    with pytest.raises(ValidationError, match="signed mission owner"):
        _agent_core_mission(repository, owner=False)


def test_agent_core_task_cannot_fall_back_to_an_acp_agent(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")

    with pytest.raises(ValidationError, match="fallback"):
        repository.submit(
            {
                "external_key": "bridge-fallback",
                "title": "Bridge fallback",
                "workspace": "/tmp/workspace",
                "owner": {"user_id": "user-1", "assertion": "signed-assertion"},
                "tasks": [
                    {
                        "key": "delegated",
                        "agent_kind": "agent-core",
                        "fallback_profiles": ["codex"],
                        "instruction": "Range mes mails",
                        "depends_on": [],
                    }
                ],
            },
            "bridge-fallback",
        )


def test_assertion_stays_out_of_the_stored_definition(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")
    mission_id = _agent_core_mission(repository)

    with repository.db.connect() as connection:
        row = connection.execute(
            "SELECT definition_json,owner_user_id,owner_assertion FROM missions WHERE id=?",
            (mission_id,),
        ).fetchone()

    assert "signed-assertion" not in row["definition_json"]
    assert row["owner_user_id"] == "user-1"
    assert row["owner_assertion"] == "signed-assertion"


def test_worker_routes_an_agent_core_task_through_the_bridge(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")
    mission_id = _agent_core_mission(repository)

    class RefusingAcpGateway:
        def execute(self, **_values) -> str:
            raise AssertionError("une tâche agent-core ne doit jamais partir en ACP")

    worker = Worker(
        "worker-1",
        repository,
        RefusingAcpGateway(),  # type: ignore[arg-type]
        agent_core=_gateway(_run_payload(response="rangé")),
    )

    assert worker.run_once() is True
    mission = repository.mission(mission_id)
    assert mission["state"] == "succeeded"
    assert json.loads(mission["tasks"][0]["result_json"])["response"] == "rangé"

    # La conversation est mémorisée pour que le prochain essai la prolonge.
    with repository.db.connect() as connection:
        stored = connection.execute(
            "SELECT agent_core_conversation_id FROM tasks WHERE mission_id=?",
            (mission_id,),
        ).fetchone()
    assert stored["agent_core_conversation_id"] == "conv-1"


def test_worker_fails_an_agent_core_task_when_the_bridge_is_absent(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")
    mission_id = _agent_core_mission(repository)

    worker = Worker("worker-1", repository, None, agent_core=None)  # type: ignore[arg-type]
    assert worker.run_once() is True

    mission = repository.mission(mission_id)
    task = mission["tasks"][0]
    assert task["state"] in {"retry_wait", "failed"}
    assert "config" in json.dumps(task["error_json"])


def test_reserved_profile_is_absent_from_the_acp_registry(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")

    # Agent Core n'est pas un agent ACP : il ne doit apparaître ni dans les
    # profils proposés au planificateur, ni dans la santé des quotas, ni dans le
    # registre du tableau de bord — mais un plan doit pouvoir le nommer.
    assert repository.enabled_profiles() == {"codex"}
    assert repository.routable_profiles() == {"codex"}
    assert [item["key"] for item in repository.profile_activity()] == ["codex"]
    assert "agent-core" in repository.plannable_profiles()


def test_profile_sync_keeps_the_reserved_profile_enabled(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "bridge.db"))
    repository.register_profile("codex", "profile-codex")
    repository.sync_profiles({"claude": "profile-claude"})

    # Une resynchronisation des agents ACP ne doit pas désactiver l'exécutant
    # Agent Core, sans quoi toute tâche déléguée deviendrait irroutable.
    assert "agent-core" in repository.plannable_profiles()
