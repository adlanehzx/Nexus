"""Redaction: sensitive data must never leak from the worker."""

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
        assert "max depth" in json.dumps(redact(deep))


class TestRedactByShape:
    def test_masks_secret_looking_values_in_any_field(self) -> None:
        result = redact({"note": "sk-abcdefghijklmnopqrstuvwxyz123456", "ok": "hello"})
        assert result["note"] == REDACTED
        assert result["ok"] == "hello"

    def test_masks_card_numbers_inline(self) -> None:
        assert "4111" not in redact_text("Paid with 4111 1111 1111 1111 this morning")

    def test_masks_known_task_secrets(self) -> None:
        out = redact_text("Logged in as secretpassword123", ("secretpassword123",))
        assert "secretpassword123" not in out
        assert REDACTED in out

    def test_ignores_short_secrets_to_avoid_mangling_text(self) -> None:
        assert redact_text("price 42 dollars", ("42",)) == "price 42 dollars"


class TestLogging:
    def test_filter_scrubs_messages(self) -> None:
        record = logging.LogRecord(
            "t", logging.INFO, __file__, 1, "key sk-abcdefghijklmnopqrstuvwxyz12", None, None
        )
        RedactingFilter().filter(record)
        assert "sk-" not in record.getMessage()

    def test_json_formatter_redacts_payload(self) -> None:
        record = logging.LogRecord("t", logging.INFO, __file__, 1, "task", None, None)
        record.task_id = "task-1"
        record.password = "hunter2"

        payload = json.loads(JsonFormatter().format(record))
        assert payload["task_id"] == "task-1"
        assert "hunter2" not in json.dumps(payload)
