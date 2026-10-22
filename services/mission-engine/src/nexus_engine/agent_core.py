from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse

from nexus_engine.acp import AcpError
from nexus_engine.domain import MissionOwner

#: Service identifier in delegation assertions.
SERVICE_NAME = "mission-engine"

#: Run stop reasons indicating user refusal or expiration.
DECLINED_STOP_REASONS = frozenset({"confirmation_rejected", "confirmation_expired"})


@dataclass(frozen=True)
class AgentCoreOutcome:
    """Agent Core run status from engine perspective."""

    status: str
    run_id: str | None
    conversation_id: str | None
    response: str | None
    confirmation_id: str | None
    renewed_assertion: str | None = None
    renewed_expires_at: str | None = None

    @property
    def awaits_confirmation(self) -> bool:
        return self.confirmation_id is not None


class AgentCoreGateway:
    """Executes a mission task by delegating to Agent Core via NEXUS API."""

    def __init__(
        self,
        base_url: str | None,
        *,
        timeout_seconds: int = 900,
        opener: Callable[[urllib.request.Request, int], Any] | None = None,
    ):
        self.base_url = base_url.rstrip("/") if base_url else None
        self.timeout_seconds = timeout_seconds
        self._opener = opener or self._default_opener

    @staticmethod
    def _default_opener(request: urllib.request.Request, timeout: int) -> Any:
        return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310

    def execute(
        self,
        *,
        mission_external_key: str,
        task_key: str,
        instruction: str,
        assertion: str | None,
        conversation_id: str | None,
        attempt_id: str,
        timeout_seconds: int,
        heartbeat: Callable[[], None],
    ) -> AgentCoreOutcome:
        """Launches an Agent Core run."""
        if self.base_url is None:
            raise AcpError("Agent Core bridge is not configured", category="config")
        if not assertion:
            raise AcpError(
                "mission has no signed owner assertion", category="auth_required"
            )

        payload = json.dumps(
            {
                "missionExternalKey": mission_external_key,
                "taskKey": task_key,
                "instruction": instruction,
                "attemptId": attempt_id,
                **({} if conversation_id is None else {"conversationId": conversation_id}),
            }
        ).encode()

        # Renew lease before long network call to prevent lease loss.
        heartbeat()
        return _read_run(
            self._call(
                "POST",
                "/api/v1/agent-core/mission-runs",
                assertion,
                min(self.timeout_seconds, timeout_seconds),
                payload,
            )
        )

    def poll(
        self,
        *,
        run_id: str,
        assertion: str | None,
        timeout_seconds: int = 30,
    ) -> AgentCoreOutcome:
        """Polls a suspended run awaiting confirmation."""
        if self.base_url is None:
            raise AcpError("Agent Core bridge is not configured", category="config")
        if not assertion:
            raise AcpError(
                "mission has no signed owner assertion", category="auth_required"
            )
        return _read_run(
            self._call(
                "GET",
                f"/api/v1/agent-core/mission-runs/{run_id}",
                assertion,
                min(self.timeout_seconds, timeout_seconds),
                None,
            )
        )

    def retire_grants(
        self,
        *,
        mission_external_key: str,
        assertion: str,
        reason: str = "completed",
        timeout_seconds: int = 30,
    ) -> int:
        """Requests retirement of assertions for a finished mission."""
        if self.base_url is None:
            raise AcpError("Agent Core bridge is not configured", category="config")
        payload = json.dumps(
            {"missionExternalKey": mission_external_key, "reason": reason}
        ).encode()
        body = self._call(
            "POST",
            "/api/v1/agent-core/mission-grants/retire",
            assertion,
            min(self.timeout_seconds, timeout_seconds),
            payload,
        )
        data = body.get("data") if isinstance(body, dict) else None
        retired = data.get("retired") if isinstance(data, dict) else None
        return int(retired) if isinstance(retired, int) else 0

    def _call(
        self,
        method: str,
        path: str,
        assertion: str,
        timeout: int,
        payload: bytes | None,
    ) -> Any:
        headers = {"authorization": f"Bearer {assertion}"}
        if payload is not None:
            headers["content-type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=payload, method=method, headers=headers
        )
        try:
            with self._opener(request, timeout) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raise AcpError(
                "Agent Core bridge refused the request",
                category=_category_for_status(exc.code),
            ) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AcpError("Agent Core bridge is unreachable", category="transport") from exc
        except json.JSONDecodeError as exc:
            raise AcpError("Agent Core bridge returned invalid JSON", category="transport") from exc


class ScheduleGrantGateway:
    """Exchanges a durable schedule delegation for a single-occurrence assertion."""

    def __init__(
        self,
        base_url: str | None,
        *,
        timeout_seconds: int = 30,
        opener: Callable[[urllib.request.Request, int], Any] | None = None,
    ):
        self.base_url = base_url.rstrip("/") if base_url else None
        self.timeout_seconds = timeout_seconds
        self._opener = opener or AgentCoreGateway._default_opener

    def exchange(
        self,
        *,
        delegation: str,
        schedule_id: str,
        scheduled_for: str,
        mission_external_key: str,
    ) -> MissionOwner:
        if self.base_url is None:
            raise AcpError("schedule grant exchange is not configured", category="config")
        payload = json.dumps(
            {
                "scheduleId": schedule_id,
                "scheduledFor": scheduled_for,
                "missionExternalKey": mission_external_key,
            }
        ).encode()
        request = urllib.request.Request(
            f"{self.base_url}/api/v1/agent-core/schedule-grants/exchange",
            data=payload,
            method="POST",
            headers={
                "authorization": f"Bearer {delegation}",
                "content-type": "application/json",
            },
        )
        try:
            with self._opener(request, self.timeout_seconds) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raise AcpError(
                "schedule grant exchange was refused",
                category=_category_for_status(exc.code),
            ) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AcpError("schedule grant exchange is unreachable", category="transport") from exc
        except json.JSONDecodeError as exc:
            raise AcpError("schedule grant exchange returned invalid JSON", category="transport") from exc
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict):
            raise AcpError("schedule grant exchange returned an invalid envelope", category="transport")
        user_id = data.get("userId")
        assertion = data.get("assertion")
        expires_at = data.get("expiresAt")
        if not isinstance(user_id, str) or not isinstance(assertion, str):
            raise AcpError("schedule grant exchange returned an invalid owner", category="transport")
        return MissionOwner(
            user_id=user_id,
            assertion=assertion,
            expires_at=expires_at if isinstance(expires_at, str) else None,
        )


def _read_run(body: Any) -> AgentCoreOutcome:
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise AcpError("Agent Core bridge returned an unexpected envelope", category="transport")

    def text(key: str) -> str | None:
        value = data.get(key)
        return str(value) if isinstance(value, str) else None

    status = text("status") or "unknown"
    stop_reason = text("stopReason")
    confirmation = data.get("confirmation")
    confirmation_id = (
        str(confirmation["id"])
        if isinstance(confirmation, dict) and isinstance(confirmation.get("id"), str)
        else None
    )
    renewed = data.get("renewedAssertion")
    renewed_assertion = (
        str(renewed["assertion"])
        if isinstance(renewed, dict) and isinstance(renewed.get("assertion"), str)
        else None
    )
    renewed_expires_at = (
        str(renewed["expiresAt"])
        if isinstance(renewed, dict) and isinstance(renewed.get("expiresAt"), str)
        else None
    )
    outcome = AgentCoreOutcome(
        status=status,
        run_id=text("runId"),
        conversation_id=text("conversationId"),
        response=text("response"),
        confirmation_id=confirmation_id,
        renewed_assertion=renewed_assertion,
        renewed_expires_at=renewed_expires_at,
    )

    if stop_reason in DECLINED_STOP_REASONS:
        raise AcpError(
            f"Agent Core run stopped: {stop_reason}", category="confirmation_declined"
        )

    if outcome.awaits_confirmation or status == "waiting_for_confirmation":
        if outcome.run_id is None:
            raise AcpError(
                "Agent Core awaits a confirmation without naming its run",
                category="transport",
            )
        return outcome

    if outcome.response is None or not outcome.response.strip():
        raise AcpError("Agent Core run returned an empty response", category="empty_response")
    return outcome


def _category_for_status(status: int) -> str:
    """Maps HTTP status code to internal error category."""
    if status in (401, 403):
        return "auth_required"
    if status == 404:
        return "config"
    if status == 429:
        return "rate_limited"
    return "transport"


def validated_base_url(value: str | None) -> str | None:
    """Validates base URL: must be HTTPS or loopback HTTP."""
    if not value:
        return None
    url = urlparse(value)
    loopback = url.hostname in {"127.0.0.1", "localhost", "::1"}
    if url.scheme == "https" or (url.scheme == "http" and loopback):
        return value
    raise ValueError("NEXUS_ENGINE_API_URL must be an HTTPS URL or a loopback HTTP URL")
