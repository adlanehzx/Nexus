"""Service-to-service authentication.

The worker is never exposed to the public Internet — it lives on an internal Docker
network without exposed ports. Network topology is a layer of defense, not an identity proof.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import Settings, get_settings


def require_token(
    authorization: str | None = Header(default=None),
    settings: Settings | None = None,
) -> None:
    """Validate bearer token in constant time."""
    settings = settings or get_settings()

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "BROWSER_UNAUTHENTICATED",
                    "message": "Missing service token.",
                    "retryable": False,
                }
            },
        )

    presented = authorization[7:].strip()
    # Constant-time comparison prevents timing attacks.
    if not hmac.compare_digest(presented, settings.auth_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "code": "BROWSER_UNAUTHENTICATED",
                    "message": "Invalid service token.",
                    "retryable": False,
                }
            },
        )
