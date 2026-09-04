"""Journalisation structurée.

Un log est un événement, pas une phrase. Le filtre de rédaction est installé sur
le gestionnaire racine : rien ne s'écrit sans passer par lui.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from .redaction import RedactingFilter, redact


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "service": "browser-worker",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("task_id", "session_id", "correlation_id", "status", "duration_ms"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)[:2000]
        return json.dumps(redact(payload), ensure_ascii=False)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())

    # browser-use est bavard : son détail n'a pas sa place dans nos journaux.
    logging.getLogger("browser_use").setLevel(logging.WARNING)
