from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse

from nexus_engine.acp import AcpError

#: Nom sous lequel le moteur se présente dans l'assertion. L'API tient une liste
#: blanche des services admis ; cette valeur doit y figurer.
SERVICE_NAME = "mission-engine"

#: Arrêts de run qui signifient qu'une personne a tranché par la négative, ou
#: n'a pas tranché à temps. La tâche échoue alors franchement : réessayer
#: rouvrirait la même confirmation et redemanderait la même décision.
DECLINED_STOP_REASONS = frozenset({"confirmation_rejected", "confirmation_expired"})


@dataclass(frozen=True)
class AgentCoreOutcome:
    """Où en est un run Agent Core, vu du moteur.

    Trois issues, et c'est tout l'intérêt de ne pas rendre un simple tuple :
    une réponse, une attente de décision humaine, ou une erreur. L'attente
    n'est pas un échec, et le type l'empêche d'être traitée comme tel par
    distraction.
    """

    status: str
    run_id: str | None
    conversation_id: str | None
    response: str | None
    confirmation_id: str | None

    @property
    def awaits_confirmation(self) -> bool:
        return self.confirmation_id is not None


class AgentCoreGateway:
    """Exécute une tâche de mission en déléguant à Agent Core, via l'API NEXUS.

    **Le moteur ne détient aucun droit propre.** Il présente l'assertion signée
    que l'API a émise au moment où l'utilisateur a confié la mission, et l'API
    en déduit pour qui et dans quelle mission le travail est permis. Le moteur
    ne choisit donc ni le compte, ni la portée — il ne peut pas les choisir,
    puisqu'il ne sait pas signer.

    Les erreurs sont traduites en ``AcpError`` avec les mêmes catégories que la
    passerelle ACP. C'est volontaire : les retries, les délais d'attente et la
    santé des profils sont déjà écrits en fonction de ces catégories, et un
    exécutant qui inventerait son propre vocabulaire d'échec passerait à côté de
    toute cette machinerie.
    """

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
        """Lance un run Agent Core.

        La conversation revient pour être mémorisée sur la tâche : au prochain
        essai, la même conversation est réutilisée et l'historique se prolonge
        au lieu de repartir de zéro.
        """
        if self.base_url is None:
            raise AcpError("Agent Core bridge is not configured", category="config")
        if not assertion:
            # Garde-fou de dernier recours : la validation du plan refuse déjà
            # une tâche Agent Core sans propriétaire signé. Si on arrive ici,
            # c'est une mission antérieure à l'identité signée, et il ne faut
            # surtout pas tenter l'appel sans portée.
            raise AcpError(
                "mission has no signed owner assertion", category="auth_required"
            )

        payload = json.dumps(
            {
                "missionExternalKey": mission_external_key,
                "taskKey": task_key,
                "instruction": instruction,
                # La tentative porte l'unicite : l'API reserve
                # (mission, tache, tentative) et rend le run deja reserve si
                # deux workers se disputent la meme. Sans ce champ, un bail
                # expire pendant un appel long produirait deux runs.
                "attemptId": attempt_id,
                **({} if conversation_id is None else {"conversationId": conversation_id}),
            }
        ).encode()

        # Le bail doit être renouvelé avant un appel qui peut durer : sans cela
        # un autre worker reprendrait la tâche pendant que celui-ci travaille.
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
        """Redemande où en est un run suspendu sur une confirmation.

        C'est le moteur qui interroge, et rien ne le notifie. Le choix est
        délibéré : la notification aurait demandé d'ouvrir sur le port du moteur
        un point d'entrée capable de marquer une tâche réussie avec un contenu
        arbitraire — sur un port que tout processus local atteint. Interroger ne
        crée aucune surface nouvelle et réutilise les bails qui existent déjà.
        """
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
    outcome = AgentCoreOutcome(
        status=status,
        run_id=text("runId"),
        conversation_id=text("conversationId"),
        response=text("response"),
        confirmation_id=confirmation_id,
    )

    # Une personne a refusé, ou n'a pas répondu à temps. C'est un échec franc :
    # réessayer rouvrirait la même confirmation.
    if stop_reason in DECLINED_STOP_REASONS:
        raise AcpError(
            f"Agent Core run stopped: {stop_reason}", category="confirmation_declined"
        )

    # Une attente de décision : rendue telle quelle, sans réponse. C'est au
    # worker de suspendre la tâche, pas à la passerelle d'en décider.
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
    """Traduit un refus HTTP en catégorie connue du moteur.

    Un 503 reste volontairement du ``transport`` et non du
    ``quota_exhausted`` : ici l'interlocuteur est notre propre API, et son
    indisponibilité ne dit rien d'un quota de fournisseur. La classer en quota
    ferait attendre à la tâche une réinitialisation qui n'arriverait jamais. Ce
    sont les catégories remontées par l'agent lui-même qui portent le sens
    « quota », pas le code de retour du pont.
    """
    if status in (401, 403):
        return "auth_required"
    if status == 404:
        # La route n'existe pas : mauvaise URL de base, ou API plus ancienne que
        # le moteur. Dans les deux cas c'est de la configuration, pas un incident.
        return "config"
    if status == 429:
        return "rate_limited"
    return "transport"


def validated_base_url(value: str | None) -> str | None:
    """Refuse une base d'API qui sortirait de la machine en clair.

    L'assertion part dans un en-tête ``Authorization``. L'envoyer en HTTP vers
    autre chose que la boucle locale la livrerait au premier intermédiaire du
    chemin ; la règle est la même que celle appliquée côté API à l'URL du
    moteur, et elle est volontairement appliquée aux deux bouts.
    """
    if not value:
        return None
    url = urlparse(value)
    loopback = url.hostname in {"127.0.0.1", "localhost", "::1"}
    if url.scheme == "https" or (url.scheme == "http" and loopback):
        return value
    raise ValueError("NEXUS_ENGINE_API_URL must be an HTTPS URL or a loopback HTTP URL")
