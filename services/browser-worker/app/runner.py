"""Exécution d'une tâche de navigation.

``TaskRunner`` est la frontière avec browser-use. Tout le reste du worker —
sessions, cycle de vie, politiques, API — ne dépend que de ce protocole, ce qui
permet de le tester sans navigateur ni modèle. Les vraies frontières externes
sont ici, et seulement ici.
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
    #: Identifiants de site. Remis à browser-use en ``sensitive_data`` : le
    #: modèle voit un marqueur, jamais la valeur.
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


#: Signature d'émission d'un événement : ``(type, payload)``.
Emit = Callable[[str, dict[str, Any]], None]


class TaskRunner(Protocol):
    async def run(self, spec: RunSpec, emit: Emit, cancel: asyncio.Event) -> RunOutcome: ...

    async def close_session(self, session_id: str) -> None: ...

    @property
    def backend_version(self) -> str | None: ...


class BrowserUseRunner:
    """Adaptateur browser-use.

    Le seul module du worker qui importe ``browser_use``. L'import est différé
    au premier usage : le worker démarre — et répond à ``/v1/health`` — même si
    le navigateur n'est pas installé, ce qui rend le diagnostic possible au lieu
    de laisser un conteneur en boucle de redémarrage.
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

                self._version = getattr(browser_use, "__version__", "inconnue")
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
        """Un navigateur par session : aucun état ne fuit d'une tâche à l'autre."""
        existing = self._browsers.get(spec.session_id)
        if existing is not None:
            return existing

        from browser_use import Browser, BrowserProfile

        # Les restrictions de domaine vivent sur `BrowserProfile`, PAS sur
        # `Browser` : les passer au mauvais objet les rendrait silencieusement
        # inopérantes — le navigateur irait partout en croyant être bridé.
        profile_kwargs: dict[str, Any] = {
            "headless": spec.headless,
            # Profil éphémère : cookies et stockage disparaissent avec la session.
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
        """Retire les actions interdites par l'intention.

        C'est la restriction **effective** : un ``read`` ne dispose pas de
        l'action « cliquer ». Le prompt n'est que la seconde ligne de défense.
        """
        excluded = spec.policy.excluded_actions
        if not excluded:
            return None
        try:
            from browser_use import Tools
        except ImportError:  # pragma: no cover - dépend de la version installée
            logger.warning("browser_use.Tools indisponible : restriction par prompt seulement")
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
                error_message=f"browser-use n'est pas installé : {exc}",
                retryable=False,
            )

        from browser_use import Agent

        steps = 0

        async def on_step_end(agent: Any) -> None:
            """Publie l'avancement de l'étape qui vient de se terminer."""
            nonlocal steps
            steps += 1
            emit("progress", {"step": steps, "maxSteps": spec.max_steps, "note": None})
            for event_type, payload in _describe_step(agent):
                emit(event_type, payload)

        async def should_stop() -> bool:
            """Annulation coopérative, consultée par browser-use entre deux étapes.

            C'est le mécanisme prévu par la bibliothèque : l'agent finit son
            étape courante puis s'arrête, au lieu d'être interrompu au milieu
            d'un clic.
            """
            return cancel.is_set()

        agent_kwargs: dict[str, Any] = {
            "task": spec.policy.prompt(spec.instructions),
            "llm": llm,
            "browser": browser,
            # `max_steps` appartient à `run()`, pas au constructeur : `Agent`
            # accepte des kwargs libres et l'avalerait sans effet.
            "task_id": spec.task_id,
            "register_should_stop_callback": should_stop,
            "step_timeout": min(spec.timeout_seconds, 120),
        }
        if tools is not None:
            agent_kwargs["tools"] = tools
        if spec.secrets:
            # browser-use substitue ces valeurs sans jamais les envoyer au modèle.
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
                error_message=f"La tâche a dépassé {spec.timeout_seconds} s.",
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
            logger.exception("échec de la tâche %s", spec.task_id)
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
            "tâche terminée task_id=%s steps=%s duration=%.2fs", spec.task_id, steps, duration
        )

        if needs_human_intervention(output):
            # Une protection humaine n'est ni contournée ni traitée comme un
            # échec : on rend la main à l'utilisateur.
            return RunOutcome(
                status=TaskStatus.needs_human,
                output=output,
                steps=steps,
                error_code="BROWSER_HUMAN_INTERVENTION_REQUIRED",
                error_message=(
                    "Le site demande une vérification humaine (CAPTCHA ou "
                    "authentification à deux facteurs). Je ne la contourne pas."
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
                    logger.warning("fermeture du navigateur %s en échec", session_id)
                    return


async def _run_agent(agent: Any, max_steps: int, on_step_end: Any) -> Any:
    """Appelle ``agent.run`` en ne passant que les arguments qu'il accepte.

    L'API de browser-use évolue vite. Plutôt que d'épingler une signature qui
    cassera à la prochaine version, on inspecte celle qui est installée.
    """
    kwargs = _supported_kwargs(agent.run, {"max_steps": max_steps, "on_step_end": on_step_end})
    return await agent.run(**kwargs)


def _supported_kwargs(target: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(target)
    except (TypeError, ValueError):  # pragma: no cover - objets non introspectables
        return kwargs

    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values()):
        return kwargs

    accepted = set(signature.parameters)
    dropped = sorted(set(kwargs) - accepted)
    if dropped:
        logger.debug("arguments ignorés par %s : %s", getattr(target, "__name__", target), dropped)
    return {key: value for key, value in kwargs.items() if key in accepted}


def _describe_step(agent: Any) -> list[tuple[str, dict[str, Any]]]:
    """Traduit l'état interne de browser-use en événements du contrat.

    Défensif par construction : l'introspection d'une bibliothèque tierce ne doit
    jamais interrompre une tâche qui, par ailleurs, se déroule bien.
    """
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
        logger.debug("introspection d'étape impossible", exc_info=True)
    return events


def _extract_output(history: Any) -> str:
    """Récupère le résultat final, quelle que soit la forme de l'historique."""
    for attr in ("final_result", "extracted_content"):
        getter = getattr(history, attr, None)
        if callable(getter):
            try:
                value = getter()
            except Exception:
                logger.debug("lecture de history.%s impossible", attr, exc_info=True)
                continue
            if isinstance(value, str) and value.strip():
                return value
            if isinstance(value, list) and value:
                return str(value[-1])
    return str(history)[:4000]
