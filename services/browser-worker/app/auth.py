"""Authentification service-à-service.

Le worker n'est jamais exposé à Internet — il vit sur un réseau Docker interne,
sans port publié. On n'en déduit pas qu'il peut se passer d'authentification :
la topologie réseau est une protection, pas une preuve d'identité.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import Settings, get_settings


def require_token(
    authorization: str | None = Header(default=None),
    settings: Settings | None = None,
) -> None:
    """Vérifie le jeton porteur en temps constant."""
    settings = settings or get_settings()

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "BROWSER_UNAUTHENTICATED",
                    "message": "Jeton de service manquant.",
                    "retryable": False,
                }
            },
        )

    presented = authorization[7:].strip()
    # Comparaison en temps constant : une comparaison naïve laisse fuiter le
    # jeton octet par octet.
    if not hmac.compare_digest(presented, settings.auth_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "BROWSER_UNAUTHENTICATED",
                    "message": "Jeton de service invalide.",
                    "retryable": False,
                }
            },
        )
