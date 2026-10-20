from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

"""Authentification des appels entrants de l'API NEXUS.

Jusqu'ici le port du moteur n'etait protege que par la boucle locale. C'est une
frontiere suffisante pour une installation personnelle sur une seule machine, et
elle ne l'est pas des qu'on ajoute Docker, plusieurs machines, des workers
distants ou une installation exposee : tout processus local pouvait soumettre une
mission, enregistrer un agent ou modifier la configuration.

**Le moteur ne detient que la cle publique.** Il verifie, il n'emet pas. C'est le
meme principe que celui qui gouverne les assertions de mission, applique dans
l'autre sens : compromettre le moteur ne permet pas de forger un appel de l'API.

Le format est celui des autres jetons de NEXUS -- un JWS compact Ed25519 --
plutot qu'une invention locale. Un seul format a comprendre, et des outils
ordinaires pour l'inspecter.
"""

#: En-tete attendu. Compare tel quel, octet par octet : un jeton qui annoncerait
#: `alg: none` ou un autre algorithme est refuse avant toute verification. C'est
#: la confusion d'algorithme, et elle se ferme ici.
_EXPECTED_HEADER = base64.urlsafe_b64encode(
    json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode()
).rstrip(b"=")

#: Audience que le moteur accepte. Constante : c'est une frontiere, pas un
#: reglage. La rendre configurable permettrait de la faire coincider par erreur
#: avec celle d'un jeton d'acces utilisateur.
MISSION_ENGINE_AUDIENCE = "nexus-mission-engine"

#: Tolerance d'horloge. Deux processus sur la meme machine derivent peu, mais
#: refuser un jeton pour une seconde d'ecart serait absurde.
_CLOCK_SKEW_SECONDS = 30


class ServiceAuthError(Exception):
    """Jeton de service refuse.

    Ne porte volontairement aucun detail exploitable : le motif precis va dans
    le journal du moteur, pas dans la reponse. Savoir *pourquoi* un jeton est
    refuse aide surtout qui essaie d'en forger un.
    """


@dataclass(frozen=True)
class ServiceIdentity:
    """Service appelant, tel que le jeton l'annonce et que la signature le prouve."""

    service: str
    token_id: str
    expires_at: int


def _decode_segment(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


class ServiceTokenVerifier:
    """Verifie les jetons de service avec la cle publique de l'API.

    Instancie une fois au demarrage : charger une cle PEM a chaque requete
    serait du gaspillage, et la cle ne change pas en cours d'execution.
    """

    def __init__(self, public_key_pem: str, *, audience: str = MISSION_ENGINE_AUDIENCE):
        key = load_pem_public_key(public_key_pem.encode())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("NEXUS_ENGINE_API_PUBLIC_KEY must be an Ed25519 public key")
        self._key = key
        self._audience = audience

    def verify(self, token: str, *, now: int | None = None) -> ServiceIdentity:
        current = int(time.time()) if now is None else now
        parts = token.split(".")
        if len(parts) != 3:
            raise ServiceAuthError("malformed token")
        header, payload, signature = parts

        if header.encode() != _EXPECTED_HEADER:
            raise ServiceAuthError("unexpected header or algorithm")

        try:
            self._key.verify(
                _decode_segment(signature), f"{header}.{payload}".encode()
            )
        except (InvalidSignature, ValueError, TypeError) as exc:
            raise ServiceAuthError("invalid signature") from exc

        try:
            claims: Any = json.loads(_decode_segment(payload))
        except (ValueError, TypeError) as exc:
            raise ServiceAuthError("malformed claims") from exc
        if not isinstance(claims, dict):
            raise ServiceAuthError("malformed claims")

        audience = claims.get("aud")
        if audience != self._audience:
            # L'audience est ce qui empeche un jeton emis pour un autre usage --
            # un jeton d'acces utilisateur, une assertion de mission -- de servir
            # ici, bien qu'il soit signe par la meme cle.
            raise ServiceAuthError("unexpected audience")

        expires_at = claims.get("exp")
        if not isinstance(expires_at, int):
            raise ServiceAuthError("missing expiry")
        if expires_at + _CLOCK_SKEW_SECONDS <= current:
            raise ServiceAuthError("expired token")

        issued_at = claims.get("iat")
        if isinstance(issued_at, int) and issued_at - _CLOCK_SKEW_SECONDS > current:
            # Un jeton date du futur signale une horloge desynchronisee ou une
            # fabrication : dans les deux cas on ne l'accepte pas.
            raise ServiceAuthError("token issued in the future")

        service = claims.get("sub")
        token_id = claims.get("jti")
        if not isinstance(service, str) or not service:
            raise ServiceAuthError("missing subject")
        if not isinstance(token_id, str) or not token_id:
            raise ServiceAuthError("missing token id")

        return ServiceIdentity(
            service=service, token_id=token_id, expires_at=expires_at
        )


def bearer_token(header: str | None) -> str:
    """Extrait le jeton d'un en-tete ``Authorization``."""
    if not header or not header.startswith("Bearer "):
        raise ServiceAuthError("missing bearer token")
    token = header[len("Bearer ") :].strip()
    if not token:
        raise ServiceAuthError("empty bearer token")
    return token
