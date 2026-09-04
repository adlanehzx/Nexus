"""Test de contrat TypeScript ↔ Python.

Le backend et le worker évoluent séparément : un champ renommé d'un côté casse
l'autre en production, pas au build (cf. risque R7). Ce test compare les schémas
JSON produits depuis Zod (`packages/browser-client`) aux modèles Pydantic d'ici.

Régénérer le contrat après toute modification du protocole :

    pnpm --filter @nexus/browser-client contract:emit
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from app.models import (
    PROTOCOL_VERSION,
    BrowserEvent,
    CreateSessionRequest,
    Health,
    Intent,
    RunTaskRequest,
    Session,
    Task,
    TaskStatus,
)

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contract" / "browser-protocol.json"


@pytest.fixture(scope="module")
def contract() -> dict[str, Any]:
    if not CONTRACT_PATH.exists():
        pytest.fail(
            f"contrat absent : {CONTRACT_PATH}\n"
            "Lancer : pnpm --filter @nexus/browser-client contract:emit"
        )
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def _properties(schema: dict[str, Any]) -> set[str]:
    return set(schema.get("properties", {}))


def _required(schema: dict[str, Any]) -> set[str]:
    return set(schema.get("required", []))


def _model_schema(model: Any) -> dict[str, Any]:
    return TypeAdapter(model).json_schema()


def test_protocol_versions_match(contract: dict[str, Any]) -> None:
    assert contract["protocolVersion"] == PROTOCOL_VERSION


@pytest.mark.parametrize(
    ("name", "model"),
    [
        ("CreateSessionRequest", CreateSessionRequest),
        ("RunTaskRequest", RunTaskRequest),
        ("Session", Session),
        ("Health", Health),
    ],
)
def test_field_names_match(contract: dict[str, Any], name: str, model: Any) -> None:
    ts_props = _properties(contract["schemas"][name])
    py_props = _properties(_model_schema(model))

    assert ts_props == py_props, (
        f"{name} : champs divergents\n"
        f"  seulement côté TypeScript : {sorted(ts_props - py_props)}\n"
        f"  seulement côté Python     : {sorted(py_props - ts_props)}"
    )


def test_task_fields_match(contract: dict[str, Any]) -> None:
    # `Task` référence `BrowserEvent`, dont le schéma Pydantic passe par $defs :
    # on compare donc les seules propriétés de premier niveau.
    ts_props = _properties(contract["schemas"]["Task"])
    py_props = _properties(_model_schema(Task))
    assert ts_props == py_props


def test_required_fields_match_on_requests(contract: dict[str, Any]) -> None:
    """Un champ obligatoire d'un côté et facultatif de l'autre casse en production."""
    for name, model in (
        ("CreateSessionRequest", CreateSessionRequest),
        ("RunTaskRequest", RunTaskRequest),
    ):
        ts_required = _required(contract["schemas"][name])
        py_required = _required(_model_schema(model))
        assert ts_required == py_required, f"{name} : obligatoires divergents"


def test_intent_values_match(contract: dict[str, Any]) -> None:
    schema = contract["schemas"]["RunTaskRequest"]["properties"]["intent"]
    ts_values = set(schema["enum"])
    assert ts_values == {intent.value for intent in Intent}


def test_task_status_values_match(contract: dict[str, Any]) -> None:
    task_schema = contract["schemas"]["Task"]["properties"]["status"]
    ts_values = set(task_schema["enum"])
    assert ts_values == {status.value for status in TaskStatus}


def test_event_types_match(contract: dict[str, Any]) -> None:
    """Chaque variante d'événement existe des deux côtés, avec les mêmes champs."""
    variants = contract["schemas"]["BrowserEvent"].get("anyOf") or contract["schemas"][
        "BrowserEvent"
    ].get("oneOf")
    assert variants, "le schéma d'événement doit être une union discriminée"

    ts_by_type: dict[str, set[str]] = {}
    for variant in variants:
        type_schema = variant["properties"]["type"]
        event_type = type_schema.get("const") or type_schema["enum"][0]
        ts_by_type[event_type] = set(variant["properties"])

    py_schema = TypeAdapter(BrowserEvent).json_schema()
    defs = py_schema.get("$defs", {})
    py_by_type: dict[str, set[str]] = {}
    for definition in defs.values():
        properties = definition.get("properties", {})
        if "type" not in properties:
            continue
        type_schema = properties["type"]
        event_type = type_schema.get("const") or (type_schema.get("enum") or [None])[0]
        if event_type in ts_by_type or event_type is not None:
            py_by_type[event_type] = set(properties)

    assert set(ts_by_type) == set(py_by_type), (
        f"types d'événements divergents\n"
        f"  TypeScript : {sorted(ts_by_type)}\n"
        f"  Python     : {sorted(py_by_type)}"
    )

    for event_type, ts_fields in ts_by_type.items():
        assert ts_fields == py_by_type[event_type], (
            f"événement « {event_type} » : champs divergents\n"
            f"  TypeScript : {sorted(ts_fields)}\n"
            f"  Python     : {sorted(py_by_type[event_type])}"
        )


def test_python_accepts_a_typescript_shaped_payload(contract: dict[str, Any]) -> None:
    """Vérification de bout en bout : une charge utile conforme au schéma TS passe."""
    assert contract["schemas"]["RunTaskRequest"]  # le contrat est bien chargé

    request = RunTaskRequest.model_validate(
        {
            "taskId": "run-1:0:browser.read:abc",
            "sessionId": "bs_1234",
            "instructions": "Trouve le prix du billet",
            "intent": "read",
            "maxSteps": 15,
            "timeoutSeconds": 180,
            "secrets": {},
            "metadata": {"runId": "run-1"},
        }
    )
    assert request.intent is Intent.read
