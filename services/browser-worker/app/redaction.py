"""Secret redaction.

Applied before any logging or response payloads are returned to the backend.
Two levels of defense: by key NAME and by value PATTERN.
"""

from __future__ import annotations

import logging
import re
from typing import Any

REDACTED = "[REDACTED]"

SECRET_KEY = re.compile(
    r"^(pass(word)?|pwd|secret|token|api[_-]?key|apikey|authorization|auth|"
    r"credential|cookie|session|card|cvv|cvc|iban|pan|"
    r"private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$",
    re.IGNORECASE,
)

SECRET_VALUE_PATTERNS = (
    re.compile(r"^sk-[A-Za-z0-9_-]{16,}$"),
    re.compile(r"^gh[pousr]_[A-Za-z0-9]{20,}$"),
    re.compile(r"^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),
    re.compile(r"^Bearer\s+\S{16,}$", re.IGNORECASE),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    # Payment card number: 13-19 digits, with optional separators.
    re.compile(r"^(?:\d[ -]?){13,19}$"),
)

#: Patterns redacted within arbitrary free-text (task outputs, error messages).
INLINE_PATTERNS = (
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b"),
)


def _looks_secret(value: str) -> bool:
    return any(p.search(value) for p in SECRET_VALUE_PATTERNS)


def redact(value: Any, max_depth: int = 8) -> Any:
    """Deep copy with secrets redacted. Never raises."""
    if isinstance(value, str):
        return REDACTED if _looks_secret(value) else value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if max_depth <= 0:
        return "[max depth reached]"
    if isinstance(value, (list, tuple)):
        return [redact(item, max_depth - 1) for item in value]
    if isinstance(value, dict):
        return {
            key: REDACTED if SECRET_KEY.match(str(key)) else redact(item, max_depth - 1)
            for key, item in value.items()
        }
    return str(value)[:500]


def redact_text(text: str, extra: tuple[str, ...] = ()) -> str:
    """Mask secrets within free-text.

    ``extra`` accepts known task secrets: even if the model echoes them,
    they are redacted before output.
    """
    out = text or ""
    for secret in extra:
        if secret and len(secret) >= 4:
            out = out.replace(secret, REDACTED)
    for pattern in INLINE_PATTERNS:
        out = pattern.sub(REDACTED, out)
    return out


class RedactingFilter(logging.Filter):
    """Logging filter: final guard before log output."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_text(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = redact(record.args)  # type: ignore[assignment]
            else:
                record.args = tuple(redact(arg) for arg in record.args)
        for key in list(vars(record)):
            if SECRET_KEY.match(key):
                setattr(record, key, REDACTED)
        return True
