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


@dataclass(frozen=True)
class ValidatedPlan:
    external_key: str
    title: str
    workspace: str
    tasks: tuple[ValidatedTask, ...]
    canonical_json: str
    content_hash: str


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def validate_plan(raw: dict[str, Any], allowed_profiles: set[str]) -> ValidatedPlan:
    if not isinstance(raw, dict):
        raise ValidationError("plan must be an object")
    allowed_top = {"external_key", "title", "workspace", "defaults", "tasks"}
    unknown = set(raw) - allowed_top
    if unknown:
        raise ValidationError(f"unknown plan fields: {', '.join(sorted(unknown))}")

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
        }
        if unknown_task:
            raise ValidationError(
                f"tasks[{index}] has unknown fields: {', '.join(sorted(unknown_task))}"
            )
        key = _required_string(item, "key", 128)
        if key in keys:
            raise ValidationError(f"duplicate task key: {key}")
        keys.add(key)
        profile = item.get("profile", defaults.get("profile"))
        if profile not in allowed_profiles:
            raise ValidationError(f"unknown or disabled profile: {profile}")
        raw_fallbacks = item.get(
            "fallback_profiles", defaults.get("fallback_profiles", [])
        )
        if not isinstance(raw_fallbacks, list) or not all(
            isinstance(value, str) and value for value in raw_fallbacks
        ):
            raise ValidationError(f"task {key}: fallback_profiles must be a string array")
        fallbacks = tuple(dict.fromkeys(raw_fallbacks))
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

    rendered = canonical_json(raw)
    return ValidatedPlan(
        external_key=external_key,
        title=title,
        workspace=workspace,
        tasks=tuple(tasks),
        canonical_json=rendered,
        content_hash=hashlib.sha256(rendered.encode()).hexdigest(),
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
