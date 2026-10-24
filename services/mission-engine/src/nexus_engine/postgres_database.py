from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, overload

import psycopg

from nexus_engine.database import SCHEMA


_ADVISORY_LOCK_ID = 7_823_940_115


class CompatibleRow(Mapping[str, Any]):
    """Row with both SQLite-style numeric and mapping access."""

    def __init__(self, columns: tuple[str, ...], values: tuple[Any, ...]):
        self._columns = columns
        self._values = values
        self._mapping = dict(zip(columns, values, strict=True))

    @overload
    def __getitem__(self, key: str) -> Any: ...

    @overload
    def __getitem__(self, key: int) -> Any: ...

    def __getitem__(self, key: str | int) -> Any:
        if isinstance(key, int):
            return self._values[key]
        return self._mapping[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._columns)

    def __len__(self) -> int:
        return len(self._columns)


class CursorAdapter:
    def __init__(self, cursor: psycopg.Cursor[tuple[Any, ...]]):
        self._cursor = cursor

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount

    def _convert(self, row: tuple[Any, ...] | None) -> CompatibleRow | None:
        if row is None:
            return None
        columns = tuple(column.name for column in self._cursor.description or ())
        return CompatibleRow(columns, row)

    def fetchone(self) -> CompatibleRow | None:
        return self._convert(self._cursor.fetchone())

    def fetchall(self) -> list[CompatibleRow]:
        return [self._convert_required(row) for row in self._cursor.fetchall()]

    def _convert_required(self, row: tuple[Any, ...]) -> CompatibleRow:
        converted = self._convert(row)
        assert converted is not None
        return converted

    def __iter__(self) -> Iterator[CompatibleRow]:
        for row in self._cursor:
            yield self._convert_required(row)


def _translate_query(query: str) -> str:
    translated = query.replace("?", "%s")
    if re.match(r"\s*INSERT\s+OR\s+IGNORE\s+INTO\s+", translated, re.IGNORECASE):
        translated = re.sub(
            r"INSERT\s+OR\s+IGNORE\s+INTO", "INSERT INTO", translated, count=1, flags=re.IGNORECASE
        )
        translated = translated.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    return translated


class ConnectionAdapter:
    def __init__(self, connection: psycopg.Connection[tuple[Any, ...]]):
        self._connection = connection

    def execute(self, query: str, params: tuple[Any, ...] = ()) -> CursorAdapter:
        cursor = self._connection.execute(_translate_query(query), params)
        return CursorAdapter(cursor)

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> ConnectionAdapter:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if exc_type is None:
            self._connection.commit()
        else:
            self._connection.rollback()
        self.close()


def postgres_schema() -> str:
    """Return the canonical schema translated to PostgreSQL-compatible DDL."""

    schema = SCHEMA.replace("PRAGMA foreign_keys = ON;", "")
    schema = schema.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
    schema = re.sub(
        r"\s+CHECK \((\w+) IS NULL OR json_valid\(\1\)\)", "", schema
    )
    schema = re.sub(r"\s+CHECK \(json_valid\(\w+\)\)", "", schema)
    return schema


class PostgresDatabase:
    """Shared Mission Engine database for fenced multi-node deployments.

    Immediate transactions take a transaction-scoped advisory lock. This keeps
    the existing repository's select-then-update state transitions atomic across
    processes while fencing tokens still reject stale workers after failover.
    """

    def __init__(self, url: str):
        if not url.startswith(("postgresql://", "postgres://")):
            raise ValueError("Mission Engine PostgreSQL URL must use postgresql://")
        self.url = url

    def _raw_connect(self) -> psycopg.Connection[tuple[Any, ...]]:
        return psycopg.connect(self.url, autocommit=False)

    def connect(self) -> ConnectionAdapter:
        return ConnectionAdapter(self._raw_connect())

    def migrate(self) -> None:
        with self.transaction(immediate=True) as connection:
            for statement in postgres_schema().split(";"):
                if statement.strip():
                    connection.execute(statement)
            connection.execute(
                """
                INSERT INTO profiles(profile_key, agent_profile_id, enabled, agent_kind)
                VALUES ('agent-core', 'agent-core', 1, 'agent-core')
                ON CONFLICT(profile_key) DO UPDATE SET enabled=1, agent_kind='agent-core'
                """
            )
            connection.execute(
                """
                INSERT INTO profile_health(profile_key,updated_at)
                SELECT profile_key, %s FROM profiles
                ON CONFLICT(profile_key) DO NOTHING
                """,
                (datetime.now(UTC).isoformat(timespec="microseconds"),),
            )

    @contextmanager
    def transaction(self, immediate: bool = False) -> Iterator[ConnectionAdapter]:
        raw = self._raw_connect()
        connection = ConnectionAdapter(raw)
        try:
            if immediate:
                connection.execute("SELECT pg_advisory_xact_lock(%s)", (_ADVISORY_LOCK_ID,))
            yield connection
            raw.commit()
        except Exception:
            raw.rollback()
            raise
        finally:
            raw.close()
