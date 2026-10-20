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
    #: Délai entre deux sondages d'une confirmation en attente. Une décision
    #: humaine se compte en minutes, pas en secondes : sonder plus souvent ne
    #: la ferait pas venir plus vite et rendrait l'attente coûteuse.
    confirmation_poll_seconds: int = 30

    def run_once(self) -> bool:
        # Les confirmations dues d'abord. Une tâche qui attend depuis
        # longtemps ne doit pas passer derrière une file de travail neuf : son
        # run est déjà ouvert côté Agent Core, et le laisser traîner retient
        # aussi tout le DAG qui en dépend.
        lease = self.repository.claim_confirmation_poll(self.worker_id, self.lease_seconds)
        if lease is None:
            lease = self.repository.acquire(self.worker_id, self.lease_seconds)
        if lease is None:
            return False
        try:
            self.repository.mark_running(lease)
            def heartbeat() -> None:
                nonlocal lease
                lease = self.repository.renew(lease, self.lease_seconds)

            if lease.agent_kind == AGENT_CORE_KIND:
                outcome = self._advance_agent_core(lease, heartbeat)
                if outcome is None:
                    # Suspendue : ni succès ni échec, et surtout pas de
                    # tentative consommée. On rend la main, la tâche sera
                    # reprise quand le prochain sondage sera dû.
                    return True
                response = outcome
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

    def _advance_agent_core(
        self, lease: Lease, heartbeat: Callable[[], None]
    ) -> str | None:
        """Fait avancer une tâche Agent Core d'un cran.

        Rend la réponse finale, ou ``None`` si la tâche vient d'être suspendue
        en attente d'une décision humaine. Le ``None`` est explicite plutôt
        qu'une exception : une attente n'est pas une erreur, et la traiter comme
        telle ferait échouer la tâche au bout de quelques essais.
        """
        if self.agent_core is None:
            raise AcpError("Agent Core executor is not configured", category="config")

        if lease.agent_core_run_id is None:
            outcome = self.agent_core.execute(
                mission_external_key=lease.mission_external_key,
                task_key=lease.task_key,
                instruction=lease.instruction,
                assertion=lease.owner_assertion,
                conversation_id=lease.agent_core_conversation_id,
                timeout_seconds=lease.timeout_seconds,
                heartbeat=heartbeat,
            )
        else:
            heartbeat()
            outcome = self.agent_core.poll(
                run_id=lease.agent_core_run_id,
                assertion=lease.owner_assertion,
            )

        # Mémorisée dès qu'elle est connue : c'est ce qui permet au prochain
        # essai de prolonger la conversation plutôt que d'en ouvrir une seconde.
        if (
            outcome.conversation_id is not None
            and outcome.conversation_id != lease.agent_core_conversation_id
        ):
            self.repository.record_agent_core_conversation(
                lease.task_id, outcome.conversation_id
            )

        if outcome.awaits_confirmation:
            self.repository.suspend(
                lease,
                run_id=str(outcome.run_id),
                confirmation_id=outcome.confirmation_id,
                poll_delay_seconds=self.confirmation_poll_seconds,
            )
            return None

        return outcome.response
