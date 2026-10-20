from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from nexus_engine.acp import AcpError, AcpGateway
from nexus_engine.agent_core import AgentCoreGateway
from nexus_engine.domain import AGENT_CORE_KIND
from nexus_engine.errors import LeaseLostError
from nexus_engine.repository import Lease, MissionRepository


@dataclass
class Worker:
    worker_id: str
    repository: MissionRepository
    gateway: AcpGateway
    lease_seconds: int = 30
    #: Exécutant Agent Core. Absent, une tâche ``agent-core`` échoue sur la
    #: catégorie ``config`` : elle ne bascule jamais sur un agent ACP, qui
    #: n'aurait ni ses outils, ni ses permissions, ni ses confirmations.
    agent_core: AgentCoreGateway | None = None

    def run_once(self) -> bool:
        lease = self.repository.acquire(self.worker_id, self.lease_seconds)
        if lease is None:
            return False
        try:
            self.repository.mark_running(lease)
            def heartbeat() -> None:
                nonlocal lease
                lease = self.repository.renew(lease, self.lease_seconds)

            if lease.agent_kind == AGENT_CORE_KIND:
                response = self._run_agent_core(lease, heartbeat)
            else:
                response = self.gateway.execute(
                    profile_key=lease.agent_profile_id,
                    workspace=lease.workspace,
                    prompt=lease.instruction,
                    timeout_seconds=lease.timeout_seconds,
                    heartbeat=heartbeat,
                )
            self.repository.succeed(lease, response)
            return True
        except Exception as exc:
            # Persist only a stable category, never a provider or HTTP response body.
            # A failure can itself mean that the lease expired between two I/O
            # calls. In that case another worker is now authoritative and this
            # worker must simply return to the queue instead of dying while it
            # tries to record the already-fenced attempt.
            try:
                category = exc.category if isinstance(exc, AcpError) else type(exc).__name__
                self.repository.fail(lease, f"worker_error_{category}")
            except LeaseLostError:
                pass
            return True

    def _run_agent_core(self, lease: Lease, heartbeat: Callable[[], None]) -> str:
        if self.agent_core is None:
            raise AcpError("Agent Core executor is not configured", category="config")

        response, conversation_id = self.agent_core.execute(
            mission_external_key=lease.mission_external_key,
            task_key=lease.task_key,
            instruction=lease.instruction,
            assertion=lease.owner_assertion,
            conversation_id=lease.agent_core_conversation_id,
            timeout_seconds=lease.timeout_seconds,
            heartbeat=heartbeat,
        )
        # Mémorisée dès qu'elle est connue : c'est ce qui permet au prochain
        # essai de prolonger la conversation plutôt que d'en ouvrir une seconde.
        if conversation_id is not None and conversation_id != lease.agent_core_conversation_id:
            self.repository.record_agent_core_conversation(lease.task_id, conversation_id)
        return response
