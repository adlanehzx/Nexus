from __future__ import annotations

from nexus_engine.database import Database
from nexus_engine.errors import LeaseLostError
from nexus_engine.repository import Lease, MissionRepository
from nexus_engine.worker import Worker


class FakeGateway:
    def execute(self, **values) -> str:
        values["heartbeat"]()
        return f"completed:{values['profile_key']}"


def test_worker_completes_a_task(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "worker.db"))
    repository.register_profile("codex", "profile-codex")
    mission_id, _ = repository.submit(
        {
            "external_key": "worker-demo",
            "title": "Worker demo",
            "workspace": "/tmp/workspace",
            "defaults": {"profile": "codex"},
            "tasks": [{"key": "one", "instruction": "Do it", "depends_on": []}],
        },
        "worker-request",
    )
    worker = Worker("worker-1", repository, FakeGateway())  # type: ignore[arg-type]
    assert worker.run_once() is True
    mission = repository.mission(mission_id)
    assert mission["state"] == "succeeded"
    assert mission["tasks"][0]["state"] == "succeeded"


def test_worker_survives_failure_after_lease_is_lost() -> None:
    lease = Lease(
        attempt_id="attempt",
        task_id="task",
        mission_id="mission",
        task_key="task",
        profile_key="codex",
        agent_profile_id="profile-codex",
        instruction="Do it",
        workspace="/tmp/workspace",
        attempt_no=1,
        conversation_id="conversation",
        lease_owner="worker-1",
        lease_token="lease-token",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        timeout_seconds=30,
    )

    class LostRepository:
        def claim_confirmation_poll(
            self, _worker_id: str, _lease_seconds: int
        ) -> Lease | None:
            # Aucune confirmation en attente : le worker enchaîne sur le travail
            # ordinaire, qui est ce que ce test exerce.
            return None

        def acquire(self, _worker_id: str, _lease_seconds: int) -> Lease:
            return lease

        def fail(self, _lease: Lease, _error: str) -> None:
            raise LeaseLostError("already reassigned")

        def mark_running(self, _lease: Lease) -> None:
            pass

    class ExplodingGateway:
        def execute(self, **_values) -> str:
            raise RuntimeError("transport stopped")

    worker = Worker("worker-1", LostRepository(), ExplodingGateway())  # type: ignore[arg-type]
    assert worker.run_once() is True
