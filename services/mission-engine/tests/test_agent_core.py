from __future__ import annotations

import json
import urllib.error
from io import BytesIO

import pytest

from nexus_engine.acp import AcpError
from nexus_engine.agent_core import AgentCoreGateway, AgentCoreOutcome, validated_base_url
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


def _awaiting_payload(conversation: str = "conv-1") -> dict:
    return {
        "data": {
            "runId": "run-1",
            "conversationId": conversation,
            "status": "waiting_for_confirmation",
            "stopReason": None,
            "response": None,
            "confirmation": {
                "id": "confirm-1",
                "toolName": "mail.send",
                "riskLevel": "high",
                "expiresAt": "2026-10-20T12:00:00.000Z",
            },
        }
    }


def _declined_payload(stop_reason: str = "confirmation_rejected") -> dict:
    return {
        "data": {
            "runId": "run-1",
            "conversationId": "conv-1",
            "status": "incomplete",
            "stopReason": stop_reason,
            "response": None,
            "confirmation": None,
        }
    }


def _run_payload(response: str = "done", conversation: str = "conv-1") -> dict:
    return {
        "data": {
            "runId": "run-1",
            "conversationId": conversation,
            "status": "completed",
            "stopReason": "final_answer",
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

    outcome = gateway.execute(
        mission_external_key="bridge-demo",
        task_key="delegated",
        instruction="Range mes mails",
        assertion="signed-assertion",
        conversation_id=None,
        timeout_seconds=120,
        heartbeat=lambda: None,
    )

    assert (outcome.response, outcome.conversation_id) == ("done", "conv-1")
    assert outcome.awaits_confirmation is False
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


def test_bridge_reports_a_pending_confirmation_without_failing() -> None:
    outcome = _gateway(_awaiting_payload()).execute(
        mission_external_key="bridge-demo",
        task_key="delegated",
        instruction="Envoie un message",
        assertion="signed-assertion",
        conversation_id=None,
        timeout_seconds=120,
        heartbeat=lambda: None,
    )

    # Une attente de décision humaine n'est pas un échec. La passerelle la rend
    # telle quelle : c'est au worker de suspendre la tâche, et une exception
    # ferait consommer une tentative pour une attente.
    assert outcome.awaits_confirmation is True
    assert (outcome.run_id, outcome.confirmation_id) == ("run-1", "confirm-1")
    assert outcome.response is None


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


class _ScriptedGateway:
    """Passerelle qui rejoue une suite d'issues, et retient ses appels.

    Suffisant pour ce que ces tests vérifient : la mécanique de suspension et
    de reprise, pas le transport — déjà couvert plus haut.
    """

    def __init__(self, outcomes: list) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[str] = []

    def execute(self, **_values):  # noqa: ANN003, ANN201
        self.calls.append("execute")
        return self.outcomes.pop(0)

    def poll(self, *, run_id: str, assertion: str | None, timeout_seconds: int = 30):  # noqa: ANN201
        self.calls.append(f"poll:{run_id}")
        return self.outcomes.pop(0)


def _awaiting(run_id: str = "run-1", confirmation_id: str = "confirm-1") -> AgentCoreOutcome:
    return AgentCoreOutcome(
        status="waiting_for_confirmation",
        run_id=run_id,
        conversation_id="conv-1",
        response=None,
        confirmation_id=confirmation_id,
    )


def _completed(response: str = "fait") -> AgentCoreOutcome:
    return AgentCoreOutcome(
        status="completed",
        run_id="run-1",
        conversation_id="conv-1",
        response=response,
        confirmation_id=None,
    )


def _suspended_task(tmp_path, outcomes: list):
    repository = MissionRepository(Database(tmp_path / "suspend.db"))
    repository.register_profile("codex", "profile-codex")
    mission_id = _agent_core_mission(repository)
    gateway = _ScriptedGateway(outcomes)
    worker = Worker(
        "worker-1",
        repository,
        None,  # type: ignore[arg-type]
        agent_core=gateway,  # type: ignore[arg-type]
        confirmation_poll_seconds=0,
    )
    return repository, worker, gateway, mission_id


def _task_row(repository: MissionRepository, mission_id: str):
    with repository.db.connect() as connection:
        return connection.execute(
            "SELECT * FROM tasks WHERE mission_id=?", (mission_id,)
        ).fetchone()


def test_a_pending_confirmation_suspends_the_task_durably(tmp_path) -> None:
    repository, worker, _gw, mission_id = _suspended_task(tmp_path, [_awaiting()])

    assert worker.run_once() is True

    task = _task_row(repository, mission_id)
    assert task["state"] == "awaiting_confirmation"
    assert task["agent_core_run_id"] == "run-1"
    assert task["agent_core_confirmation_id"] == "confirm-1"
    # Ni succès ni échec : la tâche attend, et la mission reste en cours.
    assert task["result_json"] is None
    assert repository.mission(mission_id)["state"] == "running"

    # L'attente est en base : un moteur qui redémarre la retrouve. On le
    # vérifie en relisant par un dépôt neuf sur le même fichier.
    reopened = MissionRepository(Database(tmp_path / "suspend.db"))
    assert _task_row(reopened, mission_id)["state"] == "awaiting_confirmation"


def test_an_awaited_task_does_not_consume_an_attempt(tmp_path) -> None:
    # max_attempts vaut 2 par défaut : sans cette garantie, deux sondages
    # suffiraient à faire échouer la tâche pour « trop d'essais » alors
    # qu'elle n'a fait qu'attendre.
    repository, worker, gateway, mission_id = _suspended_task(
        tmp_path, [_awaiting(), _awaiting(), _awaiting(), _completed("enfin")]
    )

    for _ in range(4):
        assert worker.run_once() is True

    with repository.db.connect() as connection:
        attempts = connection.execute(
            "SELECT COUNT(*) FROM attempts WHERE task_id=?",
            (_task_row(repository, mission_id)["id"],),
        ).fetchone()[0]

    assert attempts == 1
    assert gateway.calls == ["execute", "poll:run-1", "poll:run-1", "poll:run-1"]
    assert repository.mission(mission_id)["state"] == "succeeded"


def test_an_approved_confirmation_resumes_and_completes_the_task(tmp_path) -> None:
    repository, worker, gateway, mission_id = _suspended_task(
        tmp_path, [_awaiting(), _completed("message envoyé")]
    )

    assert worker.run_once() is True
    assert _task_row(repository, mission_id)["state"] == "awaiting_confirmation"

    # Deuxième tour : le sondage est dû, le run a été approuvé entre-temps.
    assert worker.run_once() is True

    task = _task_row(repository, mission_id)
    assert task["state"] == "succeeded"
    assert json.loads(task["result_json"])["response"] == "message envoyé"
    # La reprise interroge le run suspendu, elle ne rejoue pas l'instruction.
    assert gateway.calls == ["execute", "poll:run-1"]
    assert repository.mission(mission_id)["state"] == "succeeded"


def test_a_refused_confirmation_fails_without_retrying(tmp_path) -> None:
    def declining(**_values):  # noqa: ANN003, ANN202
        raise AcpError("stopped: confirmation_rejected", category="confirmation_declined")

    repository, worker, _gw, mission_id = _suspended_task(tmp_path, [])
    worker.agent_core.execute = declining  # type: ignore[assignment]

    assert worker.run_once() is True

    task = _task_row(repository, mission_id)
    # Pas de `retry_wait` : réessayer rouvrirait la même confirmation et
    # redemanderait la même décision à la même personne.
    assert task["state"] == "failed"
    assert "confirmation_declined" in str(task["error_json"])
    assert repository.mission(mission_id)["state"] == "failed"


def test_a_human_refusal_leaves_the_profile_healthy(tmp_path) -> None:
    def declining(**_values):  # noqa: ANN003, ANN202
        raise AcpError("stopped: confirmation_rejected", category="confirmation_declined")

    repository, worker, _gw, _mission = _suspended_task(tmp_path, [])
    worker.agent_core.execute = declining  # type: ignore[assignment]
    worker.run_once()

    health = {item["key"]: item for item in repository.profile_activity()}
    # Un refus humain n'est pas une défaillance d'agent : mettre le profil en
    # cooldown pénaliserait les missions suivantes pour une décision humaine.
    assert "agent-core" not in health
    assert health["codex"]["consecutive_failures"] == 0


def test_the_migration_adds_the_awaiting_state_to_existing_databases(tmp_path) -> None:
    import sqlite3

    from nexus_engine.database import SCHEMA

    path = tmp_path / "legacy.db"
    # Un schéma d'avant la suspension, obtenu en retirant le nouvel état du
    # schéma courant. Le dériver ainsi plutôt que de le recopier à la main
    # garantit qu'il reste réaliste quand le schéma évoluera.
    legacy_schema = SCHEMA.replace("'retry_wait','awaiting_confirmation'", "'retry_wait'")
    legacy_schema = legacy_schema.replace("'running','awaiting_confirmation'", "'running'")
    legacy = sqlite3.connect(path)
    legacy.executescript(legacy_schema)
    legacy.executescript(
        """
        INSERT INTO profiles(profile_key,agent_profile_id,enabled,agent_kind)
            VALUES ('codex','profile-codex',1,'acp');
        INSERT INTO missions(id,idempotency_key,external_key,content_hash,title,
            workspace,state,definition_json,created_at,updated_at)
            VALUES ('m1','k1','e1','h1','T','/tmp/w','running','{}','t','t');
        INSERT INTO tasks(id,mission_id,task_key,ordinal,profile_key,agent_profile_id,
            instruction,state,timeout_seconds,max_attempts,retry_delay_seconds,
            created_at,updated_at)
            VALUES ('t1','m1','k',0,'codex','profile-codex','i','ready',60,2,10,'t','t');
        INSERT INTO attempts(id,task_id,attempt_no,state,conversation_id,started_at,updated_at)
            VALUES ('a1','t1',1,'running','c1','t','t');
        """
    )
    legacy.commit()
    assert "awaiting_confirmation" not in legacy.execute(
        "SELECT sql FROM sqlite_master WHERE name='tasks'"
    ).fetchone()[0]
    legacy.close()

    Database(path).migrate()

    migrated = sqlite3.connect(path)
    for table in ("tasks", "attempts"):
        sql = migrated.execute(
            "SELECT sql FROM sqlite_master WHERE name=?", (table,)
        ).fetchone()[0]
        assert "awaiting_confirmation" in sql
    # Les lignes préexistantes survivent à la reconstruction, et les références
    # entre tables restent intactes.
    assert migrated.execute("SELECT state FROM tasks WHERE id='t1'").fetchone()[0] == "ready"
    assert migrated.execute("SELECT task_id FROM attempts WHERE id='a1'").fetchone()[0] == "t1"
    assert migrated.execute("PRAGMA foreign_key_check").fetchall() == []
    assert migrated.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    # Les index de la table reconstruite sont recréés.
    indexes = {
        row[0]
        for row in migrated.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('tasks','attempts')"
        )
    }
    assert {"idx_tasks_schedulable", "idx_attempts_lease"} <= indexes
    migrated.close()
