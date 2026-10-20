from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable
from urllib.parse import urlparse

from nexus_engine.acp import AcpError

#: Nom sous lequel le moteur se présente dans l'assertion. L'API tient une liste
#: blanche des services admis ; cette valeur doit y figurer.
SERVICE_NAME = "mission-engine"


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
        timeout_seconds: int,
        heartbeat: Callable[[], None],
    ) -> tuple[str, str | None]:
        """Lance un run Agent Core et rend ``(réponse, conversation)``.

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
                **({} if conversation_id is None else {"conversationId": conversation_id}),
            }
        ).encode()

        request = urllib.request.Request(
            f"{self.base_url}/api/v1/agent-core/mission-runs",
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {assertion}",
            },
        )

        # Le bail doit être renouvelé avant un appel qui peut durer : sans cela
        # un autre worker reprendrait la tâche pendant que celui-ci travaille.
        heartbeat()
        try:
            with self._opener(request, min(self.timeout_seconds, timeout_seconds)) as response:
                body = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raise AcpError(
                "Agent Core bridge refused the run",
                category=_category_for_status(exc.code),
            ) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AcpError("Agent Core bridge is unreachable", category="transport") from exc
        except json.JSONDecodeError as exc:
            raise AcpError("Agent Core bridge returned invalid JSON", category="transport") from exc

        return _read_run(body)


def _read_run(body: Any) -> tuple[str, str | None]:
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise AcpError("Agent Core bridge returned an unexpected envelope", category="transport")

    conversation_id = data.get("conversationId")
    conversation = str(conversation_id) if isinstance(conversation_id, str) else None

    # Un run suspendu sur une confirmation humaine n'est **pas** un échec : il
    # attend une décision. Le distinguer ici évite de le retenter en boucle, ce
    # qui rouvrirait une confirmation à chaque tentative. La suspension durable
    # reste à construire ; en l'état la tâche échoue sur une catégorie explicite
    # plutôt que de faire semblant d'avoir réussi.
    if data.get("confirmation") is not None:
        raise AcpError(
            "Agent Core run awaits a human confirmation",
            category="confirmation_required",
        )

    response = data.get("response")
    if not isinstance(response, str) or not response.strip():
        raise AcpError("Agent Core run returned an empty response", category="empty_response")
    return response, conversation


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
