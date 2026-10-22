from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from nexus_engine.errors import ValidationError


@dataclass(frozen=True)
class ValidatedTask:
    key: str
    profile: str
    fallback_profiles: tuple[str, ...]
    instruction: str
    depends_on: tuple[str, ...]
    timeout_seconds: int
    max_attempts: int
    retry_delay_seconds: int
    context_budget_chars: int
    agent_kind: str = "acp"


@dataclass(frozen=True)
class MissionOwner:
    """Signed owner identity, as issued by the API.

    ``assertion`` is opaque to the engine: it is forwarded during execution.
    It is intentionally omitted from ``canonical_json`` to preserve plan idempotency
    across assertion renewals.
    """

    user_id: str
    assertion: str
    expires_at: str | None = None


@dataclass(frozen=True)
class ValidatedPlan:
    external_key: str
    title: str
    workspace: str
    tasks: tuple[ValidatedTask, ...]
    canonical_json: str
    content_hash: str
    owner: MissionOwner | None = None


#: Executor that delegates tasks to Agent Core instead of launching an ACP agent.
AGENT_CORE_KIND = "agent-core"

#: Reserved profile for this executor.
AGENT_CORE_PROFILE = "agent-core"

AGENT_KINDS = frozenset({"acp", AGENT_CORE_KIND})


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _optional_owner(value: Any) -> MissionOwner | None:
    """Parses optional ``owner`` block of a plan."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValidationError("owner must be an object")
    unknown = set(value) - {"user_id", "assertion", "expires_at"}
    if unknown:
        raise ValidationError(f"unknown owner fields: {', '.join(sorted(unknown))}")
    expires_at = value.get("expires_at")
    if expires_at is not None and not isinstance(expires_at, str):
        raise ValidationError("owner.expires_at must be a string")
    return MissionOwner(
        user_id=_required_string(value, "user_id", 128),
        assertion=_required_string(value, "assertion", 4_096),
        expires_at=expires_at,
    )


def validate_plan(raw: dict[str, Any], allowed_profiles: set[str]) -> ValidatedPlan:
    if not isinstance(raw, dict):
        raise ValidationError("plan must be an object")
    allowed_top = {"external_key", "title", "workspace", "defaults", "tasks", "owner"}
    unknown = set(raw) - allowed_top
    if unknown:
        raise ValidationError(f"unknown plan fields: {', '.join(sorted(unknown))}")

    owner = _optional_owner(raw.get("owner"))

    external_key = _required_string(raw, "external_key", 128)
    title = _required_string(raw, "title", 300)
    workspace = _required_string(raw, "workspace", 4096)
    defaults = raw.get("defaults", {})
    if not isinstance(defaults, dict):
        raise ValidationError("defaults must be an object")
    unknown_defaults = set(defaults) - {
        "profile",
        "fallback_profiles",
        "timeout_seconds",
        "max_attempts",
        "retry_delay_seconds",
        "context_budget_chars",
    }
    if unknown_defaults:
        raise ValidationError(
            f"unknown defaults fields: {', '.join(sorted(unknown_defaults))}"
        )

    raw_tasks = raw.get("tasks")
    if not isinstance(raw_tasks, list) or not 1 <= len(raw_tasks) <= 100:
        raise ValidationError("tasks must contain between 1 and 100 items")

    tasks: list[ValidatedTask] = []
    keys: set[str] = set()
    for index, item in enumerate(raw_tasks):
        if not isinstance(item, dict):
            raise ValidationError(f"tasks[{index}] must be an object")
        unknown_task = set(item) - {
            "key",
            "profile",
            "fallback_profiles",
            "instruction",
            "depends_on",
            "timeout_seconds",
            "max_attempts",
            "retry_delay_seconds",
            "context_budget_chars",
            "agent_kind",
        }
        if unknown_task:
            raise ValidationError(
                f"tasks[{index}] has unknown fields: {', '.join(sorted(unknown_task))}"
            )
        key = _required_string(item, "key", 128)
        if key in keys:
            raise ValidationError(f"duplicate task key: {key}")
        keys.add(key)
        agent_kind = item.get("agent_kind", "acp")
        if agent_kind not in AGENT_KINDS:
            raise ValidationError(
                f"task {key}: agent_kind must be one of {', '.join(sorted(AGENT_KINDS))}"
            )
        # Agent Core executor uses a reserved profile name.
        profile = item.get("profile", defaults.get("profile"))
        if agent_kind == AGENT_CORE_KIND:
            profile = item.get("profile", AGENT_CORE_PROFILE)
        if profile not in allowed_profiles:
            raise ValidationError(f"unknown or disabled profile: {profile}")
        if (profile == AGENT_CORE_PROFILE) != (agent_kind == AGENT_CORE_KIND):
            raise ValidationError(
                f"task {key}: profile '{AGENT_CORE_PROFILE}' requires agent_kind "
                f"'{AGENT_CORE_KIND}', and conversely"
            )
        raw_fallbacks = item.get(
            "fallback_profiles", defaults.get("fallback_profiles", [])
        )
        if not isinstance(raw_fallbacks, list) or not all(
            isinstance(value, str) and value for value in raw_fallbacks
        ):
            raise ValidationError(f"task {key}: fallback_profiles must be a string array")
        fallbacks = tuple(dict.fromkeys(raw_fallbacks))
        # Fallback changes agent, not executor nature; agent-core cannot fall back to ACP.
        if agent_kind == AGENT_CORE_KIND and fallbacks:
            raise ValidationError(
                f"task {key}: an {AGENT_CORE_KIND} task cannot declare fallback profiles"
            )
        if AGENT_CORE_PROFILE in fallbacks:
            raise ValidationError(
                f"task {key}: '{AGENT_CORE_PROFILE}' cannot be used as a fallback"
            )
        if profile in fallbacks:
            raise ValidationError(f"task {key}: primary profile cannot be a fallback")
        unknown_fallbacks = set(fallbacks) - allowed_profiles
        if unknown_fallbacks:
            raise ValidationError(
                f"task {key}: unknown fallback profiles: {', '.join(sorted(unknown_fallbacks))}"
            )
        instruction = _required_string(item, "instruction", 100_000)
        dependencies = item.get("depends_on", [])
        if not isinstance(dependencies, list) or not all(
            isinstance(value, str) and value for value in dependencies
        ):
            raise ValidationError(f"task {key}: depends_on must be a string array")
        if len(dependencies) != len(set(dependencies)):
            raise ValidationError(f"task {key}: duplicate dependencies")
        timeout = _bounded_int(
            item.get("timeout_seconds", defaults.get("timeout_seconds", 1800)),
            f"task {key}: timeout_seconds",
            10,
            86_400,
        )
        max_attempts = _bounded_int(
            item.get("max_attempts", defaults.get("max_attempts", 2)),
            f"task {key}: max_attempts",
            1,
            10,
        )
        retry_delay = _bounded_int(
            item.get("retry_delay_seconds", defaults.get("retry_delay_seconds", 10)),
            f"task {key}: retry_delay_seconds",
            1,
            3600,
        )
        context_budget = _bounded_int(
            item.get(
                "context_budget_chars", defaults.get("context_budget_chars", 60_000)
            ),
            f"task {key}: context_budget_chars",
            4_000,
            400_000,
        )
        tasks.append(
            ValidatedTask(
                key=key,
                profile=str(profile),
                fallback_profiles=fallbacks,
                instruction=instruction,
                depends_on=tuple(dependencies),
                timeout_seconds=timeout,
                max_attempts=max_attempts,
                retry_delay_seconds=retry_delay,
                context_budget_chars=context_budget,
                agent_kind=agent_kind,
            )
        )

    for task in tasks:
        missing = set(task.depends_on) - keys
        if missing:
            raise ValidationError(
                f"task {task.key}: missing dependencies: {', '.join(sorted(missing))}"
            )
        if task.key in task.depends_on:
            raise ValidationError(f"task {task.key}: self dependency")
    _reject_cycles(tasks)

    # ACP tasks operate in a workspace; Agent Core tasks operate with user account permissions.
    # Therefore, a signed owner is required at plan submission time.
    if owner is None and any(task.agent_kind == AGENT_CORE_KIND for task in tasks):
        raise ValidationError(
            f"an {AGENT_CORE_KIND} task requires a signed mission owner"
        )

    # Owner assertion is not part of plan definition hash; omitted from definition_json.
    rendered = canonical_json({key: value for key, value in raw.items() if key != "owner"})
    return ValidatedPlan(
        external_key=external_key,
        title=title,
        workspace=workspace,
        tasks=tuple(tasks),
        canonical_json=rendered,
        content_hash=hashlib.sha256(rendered.encode()).hexdigest(),
        owner=owner,
    )


def _reject_cycles(tasks: list[ValidatedTask]) -> None:
    graph = {task.key: task.depends_on for task in tasks}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(key: str) -> None:
        if key in visiting:
            raise ValidationError(f"dependency cycle involving task: {key}")
        if key in visited:
            return
        visiting.add(key)
        for dependency in graph[key]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in graph:
        visit(key)


def _required_string(value: dict[str, Any], key: str, maximum: int) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip() or len(result) > maximum:
        raise ValidationError(f"{key} must be a non-empty string up to {maximum} chars")
    return result


def _bounded_int(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{label} must be an integer")
    if not minimum <= value <= maximum:
        raise ValidationError(f"{label} must be between {minimum} and {maximum}")
    return value
