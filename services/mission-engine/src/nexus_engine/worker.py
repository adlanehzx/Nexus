from __future__ import annotations

from dataclasses import dataclass

from nexus_engine.acp import AcpError, AcpGateway
from nexus_engine.errors import LeaseLostError
from nexus_engine.repository import MissionRepository


@dataclass
class Worker:
    worker_id: str
    repository: MissionRepository
    gateway: AcpGateway
    lease_seconds: int = 30

    def run_once(self) -> bool:
        lease = self.repository.acquire(self.worker_id, self.lease_seconds)
        if lease is None:
            return False
        try:
            self.repository.mark_running(lease)
            def heartbeat() -> None:
                nonlocal lease
                lease = self.repository.renew(lease, self.lease_seconds)

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
