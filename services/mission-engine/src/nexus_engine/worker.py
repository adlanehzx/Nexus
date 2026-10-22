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
    #: Agent Core executor. When absent, an agent-core task fails with category "config".
    agent_core: AgentCoreGateway | None = None
    #: Delay between two polls of a pending confirmation in seconds.
    confirmation_poll_seconds: int = 30

    def run_once(self) -> bool:
        # Prioritize due confirmations so suspended tasks resume quickly.
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
                    # Suspended awaiting confirmation: neither success nor failure.
                    # Yield execution; task resumes on next poll.
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
            self._retire_grants_if_mission_finished(lease)
            return True
        except Exception as exc:
            # Persist only a stable category, never a provider or HTTP response body.
            try:
                category = exc.category if isinstance(exc, AcpError) else type(exc).__name__
                self.repository.fail(lease, f"worker_error_{category}")
            except LeaseLostError:
                pass
            return True

    def _retire_grants_if_mission_finished(self, lease: Lease) -> None:
        """Retires owner assertions once mission reaches a terminal state."""
        if self.agent_core is None or lease.owner_assertion is None:
            return
        assertion = self.repository.terminal_mission_with_assertion(lease.mission_id)
        if assertion is None:
            return
        try:
            self.agent_core.retire_grants(
                mission_external_key=lease.mission_external_key,
                assertion=assertion,
            )
        except AcpError:
            # If retirement call fails, assertions will expire naturally.
            return
        self.repository.clear_owner_assertion(lease.mission_id)

    def _advance_agent_core(
        self, lease: Lease, heartbeat: Callable[[], None]
    ) -> str | None:
        """Advances an Agent Core task one step.

        Returns final response string, or None if suspended waiting for confirmation.
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
                attempt_id=lease.attempt_id,
                timeout_seconds=lease.timeout_seconds,
                heartbeat=heartbeat,
            )
        else:
            heartbeat()
            outcome = self.agent_core.poll(
                run_id=lease.agent_core_run_id,
                assertion=lease.owner_assertion,
            )

        # Rotate renewed assertion immediately if provided.
        if outcome.renewed_assertion is not None:
            self.repository.rotate_owner_assertion(
                lease.mission_id,
                outcome.renewed_assertion,
                outcome.renewed_expires_at,
            )

        # Record conversation ID as soon as received for continuity.
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
