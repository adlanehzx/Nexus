"""Execution of browser navigation tasks.

``TaskRunner`` forms the abstraction boundary over browser-use. All other worker
components — sessions, lifecycle, policies, API — depend solely on this protocol,
enabling isolated unit testing without physical browsers or LLMs.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from .models import Intent, TaskStatus
from .policies import DomainBlocked, TaskPolicy, needs_human_intervention
from .redaction import redact_text

logger = logging.getLogger(__name__)


@dataclass
class RunSpec:
    task_id: str
    session_id: str
    instructions: str
    intent: Intent
    policy: TaskPolicy
    max_steps: int
    timeout_seconds: int
    #: Site credentials passed to browser-use as ``sensitive_data``:
    #: placeholders are presented to the model instead of raw values.
    secrets: dict[str, str] = field(default_factory=dict)
    headless: bool = True


@dataclass
class RunOutcome:
    status: TaskStatus
    output: str = ""
    steps: int = 0
    error_code: str | None = None
    error_message: str | None = None
    retryable: bool = False


#: Event emission callback: ``(type, payload)``.
Emit = Callable[[str, dict[str, Any]], None]


class TaskRunner(Protocol):
    async def run(self, spec: RunSpec, emit: Emit, cancel: asyncio.Event) -> RunOutcome: ...

    async def close_session(self, session_id: str) -> None: ...

    @property
    def backend_version(self) -> str | None: ...


class BrowserUseRunner:
    """browser-use adapter.

    The sole module importing ``browser_use``. The import is deferred until
    first invocation so the service boots and answers ``/v1/health`` even if
    system Chromium is not installed.
    """

    def __init__(self, *, model: str, api_key: str | None = None) -> None:
        self._model = model
        self._api_key = api_key
        self._browsers: dict[str, Any] = {}
        self._version: str | None = None

    @property
    def backend_version(self) -> str | None:
        if self._version is None:
            try:
                import browser_use

                self._version = getattr(browser_use, "__version__", "unknown")
            except ImportError:
                self._version = None
        return self._version

    def _build_llm(self) -> Any:
        from browser_use import ChatAnthropic

        kwargs: dict[str, Any] = {"model": self._model}
        if self._api_key:
            kwargs["api_key"] = self._api_key
        return ChatAnthropic(**kwargs)

    async def _browser_for(self, spec: RunSpec) -> Any:
        """One isolated browser context per session."""
        existing = self._browsers.get(spec.session_id)
        if existing is not None:
            return existing

        from browser_use import Browser, BrowserProfile

        profile_kwargs: dict[str, Any] = {
            "headless": spec.headless,
            # Ephemeral user profile: cookies and storage disappear with the session.
            "user_data_dir": None,
        }
        if spec.policy.domains.allowed:
            profile_kwargs["allowed_domains"] = list(spec.policy.domains.allowed)
        if spec.policy.domains.prohibited:
            profile_kwargs["prohibited_domains"] = list(spec.policy.domains.prohibited)

        profile = BrowserProfile(**profile_kwargs)
        browser = Browser(browser_profile=profile)
        self._browsers[spec.session_id] = browser
        return browser

    def _build_tools(self, spec: RunSpec) -> Any | None:
        """Strip actions disallowed by task intent."""
        excluded = spec.policy.excluded_actions
        if not excluded:
            return None
        try:
            from browser_use import Tools
        except ImportError:  # pragma: no cover
            logger.warning("browser_use.Tools unavailable: falling back to prompt restriction only")
            return None
        return Tools(exclude_actions=excluded)

    async def run(self, spec: RunSpec, emit: Emit, cancel: asyncio.Event) -> RunOutcome:
        started = time.monotonic()
        emit("started", {"intent": spec.intent.value})

        try:
            browser = await self._browser_for(spec)
            llm = self._build_llm()
            tools = self._build_tools(spec)
        except ImportError as exc:
            return RunOutcome(
                status=TaskStatus.failed,
                error_code="BROWSER_WORKER_UNAVAILABLE",
                error_message=f"browser-use is not installed: {exc}",
                retryable=False,
            )

        from browser_use import Agent

        steps = 0

        async def on_step_end(agent: Any) -> None:
            """Emit step progress notification."""
            nonlocal steps
            steps += 1
            emit("progress", {"step": steps, "maxSteps": spec.max_steps, "note": None})
            for event_type, payload in _describe_step(agent):
                emit(event_type, payload)

        async def should_stop() -> bool:
            """Cooperative cancellation callback."""
            return cancel.is_set()

        agent_kwargs: dict[str, Any] = {
            "task": spec.policy.prompt(spec.instructions),
            "llm": llm,
            "browser": browser,
            "task_id": spec.task_id,
            "register_should_stop_callback": should_stop,
            "step_timeout": min(spec.timeout_seconds, 120),
        }
        if tools is not None:
            agent_kwargs["tools"] = tools
        if spec.secrets:
            agent_kwargs["sensitive_data"] = dict(spec.secrets)

        agent = Agent(**_supported_kwargs(Agent, agent_kwargs))

        try:
            history = await asyncio.wait_for(
                _run_agent(agent, spec.max_steps, on_step_end),
                timeout=spec.timeout_seconds,
            )
        except TimeoutError:
            return RunOutcome(
                status=TaskStatus.timeout,
                steps=steps,
                error_code="BROWSER_TASK_TIMEOUT",
                error_message=f"Task exceeded {spec.timeout_seconds}s timeout.",
                retryable=True,
            )
        except DomainBlocked as exc:
            return RunOutcome(
                status=TaskStatus.failed,
                steps=steps,
                error_code="BROWSER_DOMAIN_BLOCKED",
                error_message=str(exc),
            )
        except Exception as exc:
            logger.exception("task failed %s", spec.task_id)
            return RunOutcome(
                status=TaskStatus.failed,
                steps=steps,
                error_code="BROWSER_TASK_FAILED",
                error_message=redact_text(str(exc), tuple(spec.secrets.values())),
                retryable=True,
            )

        if cancel.is_set():
            return RunOutcome(status=TaskStatus.cancelled, steps=steps)

        output = redact_text(_extract_output(history), tuple(spec.secrets.values()))
        duration = time.monotonic() - started
        logger.info(
            "task finished task_id=%s steps=%s duration=%.2fs", spec.task_id, steps, duration
        )

        if needs_human_intervention(output):
            return RunOutcome(
                status=TaskStatus.needs_human,
                output=output,
                steps=steps,
                error_code="BROWSER_HUMAN_INTERVENTION_REQUIRED",
                error_message=(
                    "The site requires human verification (CAPTCHA or "
                    "two-factor authentication). Autonomous bypass is prohibited."
                ),
            )

        return RunOutcome(status=TaskStatus.succeeded, output=output, steps=steps)

    async def close_session(self, session_id: str) -> None:
        browser = self._browsers.pop(session_id, None)
        if browser is None:
            return
        for method in ("kill", "stop", "close"):
            closer = getattr(browser, method, None)
            if callable(closer):
                try:
                    result = closer()
                    if inspect.isawaitable(result):
                        await result
                    return
                except Exception:
                    logger.warning("browser shutdown failed for %s", session_id)
                    return


async def _run_agent(agent: Any, max_steps: int, on_step_end: Any) -> Any:
    """Call ``agent.run`` with supported arguments."""
    kwargs = _supported_kwargs(agent.run, {"max_steps": max_steps, "on_step_end": on_step_end})
    return await agent.run(**kwargs)


def _supported_kwargs(target: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(target)
    except (TypeError, ValueError):  # pragma: no cover
        return kwargs

    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values()):
        return kwargs

    accepted = set(signature.parameters)
    dropped = sorted(set(kwargs) - accepted)
    if dropped:
        logger.debug("arguments ignored by %s: %s", getattr(target, "__name__", target), dropped)
    return {key: value for key, value in kwargs.items() if key in accepted}


def _describe_step(agent: Any) -> list[tuple[str, dict[str, Any]]]:
    """Map browser-use step state to protocol event payloads."""
    events: list[tuple[str, dict[str, Any]]] = []
    try:
        state = getattr(agent, "state", None)
        history = getattr(state, "history", None)

        urls = getattr(history, "urls", None)
        if callable(urls):
            visited = [u for u in urls() if isinstance(u, str) and u]
            if visited:
                events.append(("navigation", {"url": visited[-1], "title": None}))

        thoughts = getattr(history, "model_thoughts", None)
        if callable(thoughts):
            items = thoughts()
            if items:
                text = str(getattr(items[-1], "next_goal", "") or items[-1])
                if text:
                    events.append(("thinking", {"text": text[:500]}))

        actions = getattr(history, "action_names", None)
        if callable(actions):
            names = [n for n in actions() if n]
            if names:
                events.append(("action", {"action": str(names[-1]), "target": None}))
    except Exception:
        logger.debug("step introspection failed", exc_info=True)
    return events


def _extract_output(history: Any) -> str:
    """Extract final text output from execution history."""
    for attr in ("final_result", "extracted_content"):
        getter = getattr(history, attr, None)
        if callable(getter):
            try:
                value = getter()
            except Exception:
                logger.debug("reading history.%s failed", attr, exc_info=True)
                continue
            if isinstance(value, str) and value.strip():
                return value
            if isinstance(value, list) and value:
                return str(value[-1])
    return str(history)[:4000]
