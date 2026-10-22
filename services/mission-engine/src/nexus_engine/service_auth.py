from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

"""Inbound authentication for NEXUS API calls.

The engine holds only the public key. It verifies incoming requests and cannot
issue tokens. Format is compact Ed25519 JWS.
"""

#: Expected header matching EdDSA JWT.
_EXPECTED_HEADER = base64.urlsafe_b64encode(
    json.dumps({"alg": "EdDSA", "typ": "JWT"}, separators=(",", ":")).encode()
).rstrip(b"=")

#: Audience accepted by mission engine.
MISSION_ENGINE_AUDIENCE = "nexus-mission-engine"

#: Clock skew tolerance in seconds.
_CLOCK_SKEW_SECONDS = 30


class ServiceAuthError(Exception):
    """Service token verification error."""


@dataclass(frozen=True)
class ServiceIdentity:
    """Authenticated calling service identity."""

    service: str
    token_id: str
    expires_at: int


def _decode_segment(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


class ServiceTokenVerifier:
    """Verifies service tokens using API public key."""

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
            raise ServiceAuthError("unexpected audience")

        expires_at = claims.get("exp")
        if not isinstance(expires_at, int):
            raise ServiceAuthError("missing expiry")
        if expires_at + _CLOCK_SKEW_SECONDS <= current:
            raise ServiceAuthError("expired token")

        issued_at = claims.get("iat")
        if isinstance(issued_at, int) and issued_at - _CLOCK_SKEW_SECONDS > current:
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
    """Extracts token from an ``Authorization`` header."""
    if not header or not header.startswith("Bearer "):
        raise ServiceAuthError("missing bearer token")
    token = header[len("Bearer ") :].strip()
    if not token:
        raise ServiceAuthError("empty bearer token")
    return token
