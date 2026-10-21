"""Rédaction : rien de sensible ne doit sortir du worker."""

from __future__ import annotations

import json
import logging

from app.logging_setup import JsonFormatter
from app.redaction import REDACTED, RedactingFilter, redact, redact_text


class TestRedactByKey:
    def test_masks_known_secret_keys(self) -> None:
        result = redact(
            {
                "user": "example",
                "password": "hunter2",
                "apiKey": "abc",
                "cookie": "session=1",
                "card": "4111111111111111",
                "nested": {"client_secret": "s"},
            }
        )
        assert result == {
            "user": "example",
            "password": REDACTED,
            "apiKey": REDACTED,
            "cookie": REDACTED,
            "card": REDACTED,
            "nested": {"client_secret": REDACTED},
        }

    def test_survives_deep_structures(self) -> None:
        deep: dict = {"v": 1}
        for _ in range(20):
            deep = {"child": deep}
        assert "profondeur maximale" in json.dumps(redact(deep))


class TestRedactByShape:
    def test_masks_secret_looking_values_in_any_field(self) -> None:
        # Un secret finit toujours par se retrouver dans un champ innocent.
        result = redact({"note": "sk-abcdefghijklmnopqrstuvwxyz123456", "ok": "bonjour"})
        assert result["note"] == REDACTED
        assert result["ok"] == "bonjour"

    def test_masks_card_numbers_inline(self) -> None:
        assert "4111" not in redact_text("Payé avec 4111 1111 1111 1111 ce matin")

    def test_masks_known_task_secrets(self) -> None:
        # Même si le modèle recopie l'identifiant dans son résultat.
        out = redact_text("Connecté en tant que motdepasse123", ("motdepasse123",))
        assert "motdepasse123" not in out
        assert REDACTED in out

    def test_ignores_short_secrets_to_avoid_mangling_text(self) -> None:
        assert redact_text("prix 42 euros", ("42",)) == "prix 42 euros"


class TestLogging:
    def test_filter_scrubs_messages(self) -> None:
        record = logging.LogRecord(
            "t", logging.INFO, __file__, 1, "clé sk-abcdefghijklmnopqrstuvwxyz12", None, None
        )
        RedactingFilter().filter(record)
        assert "sk-" not in record.getMessage()

    def test_json_formatter_redacts_payload(self) -> None:
        record = logging.LogRecord("t", logging.INFO, __file__, 1, "tâche", None, None)
        record.task_id = "task-1"
        record.password = "hunter2"

        payload = json.loads(JsonFormatter().format(record))
        assert payload["task_id"] == "task-1"
        assert "hunter2" not in json.dumps(payload)
