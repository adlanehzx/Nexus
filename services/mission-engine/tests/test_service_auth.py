from __future__ import annotations

import base64
import json
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from fastapi.testclient import TestClient

from nexus_engine.api import create_app
from nexus_engine.config import Settings
from nexus_engine.service_auth import (
    MISSION_ENGINE_AUDIENCE,
    ServiceAuthError,
    ServiceTokenVerifier,
    bearer_token,
)

"""Authentification des appels entrants de l'API vers le moteur.

Le port du moteur n'etait protege que par la boucle locale : tout processus
local pouvait soumettre une mission, enregistrer un agent ou modifier la
configuration. Ces tests fixent ce que la nouvelle barriere refuse, parce que
c'est la seule chose qui compte pour une barriere.

Le moteur ne detient que la cle publique. Les jetons sont donc forges ici avec
une cle privee de test -- comme le ferait l'API -- et le moteur, lui, est
incapable d'en produire.
"""


def _keys() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    public_pem = (
        private.public_key()
        .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return private, public_pem


def _segment(payload: dict) -> str:
    return (
        base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
        .rstrip(b"=")
        .decode()
    )


def _token(
    private: Ed25519PrivateKey,
    *,
    audience: str = MISSION_ENGINE_AUDIENCE,
    subject: str = "nexus-api",
    issued_at: int | None = None,
    expires_at: int | None = None,
    header: dict | None = None,
) -> str:
    now = int(time.time())
    head = _segment(header or {"alg": "EdDSA", "typ": "JWT"})
    body = _segment(
        {
            "sub": subject,
            "iat": now if issued_at is None else issued_at,
            "exp": now + 120 if expires_at is None else expires_at,
            "iss": "nexus",
            "aud": audience,
            "jti": "token-1",
        }
    )
    signature = (
        base64.urlsafe_b64encode(private.sign(f"{head}.{body}".encode()))
        .rstrip(b"=")
        .decode()
    )
    return f"{head}.{body}.{signature}"


def test_accepts_a_token_signed_by_the_api() -> None:
    private, public_pem = _keys()
    identity = ServiceTokenVerifier(public_pem).verify(_token(private))
    assert identity.service == "nexus-api"
    assert identity.token_id == "token-1"


def test_refuses_a_token_signed_by_another_key() -> None:
    _, public_pem = _keys()
    foreign, _ = _keys()
    with pytest.raises(ServiceAuthError, match="signature"):
        ServiceTokenVerifier(public_pem).verify(_token(foreign))


def test_refuses_a_token_meant_for_another_audience() -> None:
    private, public_pem = _keys()
    # Signe par la bonne cle, mais emis pour une autre surface : une assertion
    # de mission ou un jeton d'acces utilisateur ne doit pas ouvrir ici.
    with pytest.raises(ServiceAuthError, match="audience"):
        ServiceTokenVerifier(public_pem).verify(
            _token(private, audience="nexus-mission-grant")
        )


def test_refuses_an_expired_token() -> None:
    private, public_pem = _keys()
    now = int(time.time())
    with pytest.raises(ServiceAuthError, match="expired"):
        ServiceTokenVerifier(public_pem).verify(
            _token(private, expires_at=now - 120), now=now
        )


def test_tolerates_a_small_clock_drift() -> None:
    private, public_pem = _keys()
    now = int(time.time())
    # Expire il y a dix secondes : deux processus de la meme machine derivent,
    # et refuser pour dix secondes d'ecart serait absurde.
    identity = ServiceTokenVerifier(public_pem).verify(
        _token(private, expires_at=now - 10), now=now
    )
    assert identity.service == "nexus-api"


def test_refuses_a_token_dated_from_the_future() -> None:
    private, public_pem = _keys()
    now = int(time.time())
    with pytest.raises(ServiceAuthError, match="future"):
        ServiceTokenVerifier(public_pem).verify(
            _token(private, issued_at=now + 3_600, expires_at=now + 7_200), now=now
        )


def test_refuses_an_unsigned_token() -> None:
    private, public_pem = _keys()
    # Confusion d'algorithme : l'en-tete annonce `none`, et le refus intervient
    # avant toute verification de signature.
    with pytest.raises(ServiceAuthError, match="header|signature"):
        ServiceTokenVerifier(public_pem).verify(
            _token(private, header={"alg": "none", "typ": "JWT"})
        )


def test_refuses_a_malformed_token() -> None:
    _, public_pem = _keys()
    verifier = ServiceTokenVerifier(public_pem)
    for value in ("", "a.b", "a.b.c.d"):
        with pytest.raises(ServiceAuthError):
            verifier.verify(value)


def test_refuses_a_valid_key_of_the_wrong_type() -> None:
    from cryptography.hazmat.primitives.asymmetric import ec

    # Une cle parfaitement valide, mais pas Ed25519. C'est le cas interessant :
    # un PEM corrompu echoue de lui-meme au parsing, alors qu'une cle EC
    # passerait si on ne verifiait pas le type -- et le moteur verifierait alors
    # des signatures avec un algorithme que l'API n'utilise pas.
    wrong = (
        ec.generate_private_key(ec.SECP256R1())
        .public_key()
        .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    with pytest.raises(ValueError, match="Ed25519"):
        ServiceTokenVerifier(wrong)


def test_refuses_a_corrupted_public_key() -> None:
    with pytest.raises(ValueError):
        ServiceTokenVerifier("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n")


def test_bearer_header_parsing() -> None:
    assert bearer_token("Bearer abc") == "abc"
    for value in (None, "", "abc", "Bearer ", "Basic abc"):
        with pytest.raises(ServiceAuthError):
            bearer_token(value)


def _settings(tmp_path, public_pem: str | None) -> Settings:
    return Settings(
        database_path=tmp_path / "engine.db",
        acp_runner=None,
        acp_registry=None,
        worker_enabled=False,
        worker_concurrency=1,
        profiles_file=tmp_path / "profiles.json",
        runtime_settings_file=tmp_path / "runtime.json",
        api_public_key_pem=public_pem,
    )


def test_mutations_require_a_service_token_when_a_key_is_configured(tmp_path) -> None:
    private, public_pem = _keys()
    client = TestClient(create_app(_settings(tmp_path, public_pem)))

    # La lecture reste libre : la boucle locale suffit a la proteger, et c'est
    # l'ecriture qui compte.
    assert client.get("/v1/health/ready").status_code == 200

    body = {"task_timeout_seconds": 1800, "max_attempts": 2, "retry_delay_seconds": 10,
            "context_budget_chars": 60000, "quality_review": True,
            "research_priority": ["codex"], "review_priority": ["codex"],
            "synthesis_priority": ["codex"]}

    assert client.put("/v1/settings", json=body).status_code == 401
    accepted = client.put(
        "/v1/settings",
        json=body,
        headers={"authorization": f"Bearer {_token(private)}"},
    )
    assert accepted.status_code == 200


def test_every_mutating_route_is_covered(tmp_path) -> None:
    """Le middleware protege par methode, pas par liste de routes.

    C'est l'invariant qui compte : la route de mutation ajoutee demain est
    couverte sans qu'on y pense, la ou un `Depends` oublie ne produit aucune
    erreur -- juste une route ouverte.
    """
    _, public_pem = _keys()
    app = create_app(_settings(tmp_path, public_pem))
    client = TestClient(app)

    mutating = [
        (method, route.path)
        for route in app.routes
        for method in getattr(route, "methods", set())
        if method in {"POST", "PUT", "PATCH", "DELETE"}
    ]
    assert len(mutating) >= 14

    for method, path in mutating:
        # Chemin concret : les parametres importent peu, le refus intervient
        # avant tout routage de corps.
        concrete = path.replace("{profile_key}", "x").replace("{profile_id}", "x")
        concrete = concrete.replace("{market_id}", "x").replace("{mission_id}", "x")
        response = client.request(method, concrete, json={})
        assert response.status_code == 401, f"{method} {path} n'exige pas de jeton"


def test_without_a_key_the_engine_keeps_its_previous_posture(tmp_path) -> None:
    client = TestClient(create_app(_settings(tmp_path, None)))
    body = {"task_timeout_seconds": 1800, "max_attempts": 2, "retry_delay_seconds": 10,
            "context_budget_chars": 60000, "quality_review": True,
            "research_priority": ["codex"], "review_priority": ["codex"],
            "synthesis_priority": ["codex"]}
    # Documente plutot que corrige : sans cle configuree, la barriere est la
    # boucle locale seule. Le demarrage l'annonce dans le journal.
    assert client.put("/v1/settings", json=body).status_code == 200
