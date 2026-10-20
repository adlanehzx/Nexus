from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from nexus_engine.database import Database
from nexus_engine.domain import canonical_json, validate_plan
from nexus_engine.errors import (
    ConflictError,
    LeaseLostError,
    NotFoundError,
    ValidationError,
)
from nexus_engine.repository import MissionRepository, timestamp

_FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValidationError("scheduled dates must include a timezone")
    return value.astimezone(UTC)


def _parse_field(
    raw: str, minimum: int, maximum: int, *, weekday: bool = False
) -> set[int]:
    values: set[int] = set()
    for item in raw.split(","):
        if not item:
            raise ValidationError("invalid cron expression")
        base, separator, step_raw = item.partition("/")
        try:
            step = int(step_raw) if separator else 1
        except ValueError as exc:
            raise ValidationError("invalid cron step") from exc
        if step < 1:
            raise ValidationError("cron steps must be positive")
        if base == "*":
            start, end = minimum, maximum
        elif "-" in base:
            left, right = base.split("-", 1)
            try:
                start, end = int(left), int(right)
            except ValueError as exc:
                raise ValidationError("invalid cron range") from exc
        else:
            try:
                start = end = int(base)
            except ValueError as exc:
                raise ValidationError("invalid cron value") from exc
        if start < minimum or end > maximum or start > end:
            raise ValidationError("cron value is outside its allowed range")
        values.update(range(start, end + 1, step))
    if weekday and 7 in values:
        values.remove(7)
        values.add(0)
    return values


@dataclass(frozen=True)
class CronExpression:
    expression: str
    minutes: frozenset[int]
    hours: frozenset[int]
    month_days: frozenset[int]
    months: frozenset[int]
    week_days: frozenset[int]
    month_day_wildcard: bool
    week_day_wildcard: bool

    @classmethod
    def parse(cls, expression: str) -> CronExpression:
        parts = expression.split()
        if len(parts) != 5:
            raise ValidationError("cron_expression must contain five fields")
        parsed = [
            _parse_field(raw, *bounds, weekday=index == 4)
            for index, (raw, bounds) in enumerate(
                zip(parts, _FIELD_RANGES, strict=True)
            )
        ]
        return cls(
            expression=expression,
            minutes=frozenset(parsed[0]),
            hours=frozenset(parsed[1]),
            month_days=frozenset(parsed[2]),
            months=frozenset(parsed[3]),
            week_days=frozenset(parsed[4]),
            month_day_wildcard=parsed[2] == set(range(1, 32)),
            week_day_wildcard=parsed[4] == set(range(7)),
        )

    def matches(self, instant: datetime, timezone: ZoneInfo) -> bool:
        local = instant.astimezone(timezone)
        # Python: lundi=0. Cron: dimanche=0, lundi=1.
        cron_weekday = (local.weekday() + 1) % 7
        month_day_matches = local.day in self.month_days
        week_day_matches = cron_weekday in self.week_days
        if self.month_day_wildcard:
            day_matches = week_day_matches
        elif self.week_day_wildcard:
            day_matches = month_day_matches
        else:
            # Sémantique cron historique : DOM et DOW sont reliés par OU.
            day_matches = month_day_matches or week_day_matches
        return (
            local.minute in self.minutes
            and local.hour in self.hours
            and local.month in self.months
            and day_matches
        )

    def next_after(self, value: datetime, timezone: ZoneInfo) -> datetime:
        candidate = _utc(value).replace(second=0, microsecond=0) + timedelta(minutes=1)
        for _ in range(5 * 366 * 24 * 60):
            if self.matches(candidate, timezone):
                return candidate
            candidate += timedelta(minutes=1)
        raise ValidationError(
            "cron expression has no occurrence in the next five years"
        )

    def previous_at_or_before(self, value: datetime, timezone: ZoneInfo) -> datetime:
        candidate = _utc(value).replace(second=0, microsecond=0)
        for _ in range(5 * 366 * 24 * 60):
            if self.matches(candidate, timezone):
                return candidate
            candidate -= timedelta(minutes=1)
        raise ValidationError("cron expression has no recent occurrence")


@dataclass(frozen=True)
class ScheduleLease:
    run_id: str
    schedule_id: str
    scheduled_for: str
    mission_template: dict[str, Any]
    lease_owner: str
    lease_token: str


class SchedulerRepository:
    def __init__(self, database: Database, missions: MissionRepository):
        self.db = database
        self.missions = missions
        self.db.migrate()

    @staticmethod
    def _timezone(name: str) -> ZoneInfo:
        try:
            return ZoneInfo(name)
        except ZoneInfoNotFoundError as exc:
            raise ValidationError(f"unknown timezone: {name}") from exc

    def create(
        self,
        *,
        name: str,
        mission: dict[str, Any],
        timezone: str,
        run_at: datetime | None,
        cron_expression: str | None,
        catch_up_policy: str,
        max_catch_up: int,
        max_concurrency: int,
        misfire_grace_seconds: int,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        current = _utc(now or datetime.now(UTC))
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValidationError("name must be a non-empty string up to 200 chars")
        if bool(run_at) == bool(cron_expression):
            raise ValidationError(
                "exactly one of run_at or cron_expression is required"
            )
        if catch_up_policy not in {"skip", "latest", "all"}:
            raise ValidationError("invalid catch_up_policy")
        if not 1 <= max_catch_up <= 100:
            raise ValidationError("max_catch_up must be between 1 and 100")
        if not 1 <= max_concurrency <= 32:
            raise ValidationError("max_concurrency must be between 1 and 32")
        if not 0 <= misfire_grace_seconds <= 86_400:
            raise ValidationError("misfire_grace_seconds must be between 0 and 86400")
        zone = self._timezone(timezone)
        validated = validate_plan(mission, self.missions.plannable_profiles())
        template = json.loads(validated.canonical_json)
        if validated.owner is not None:
            raise ValidationError(
                "schedules cannot persist an expiring owner assertion"
            )
        if run_at is not None:
            first = _utc(run_at)
            schedule_kind = "one_shot"
            cron = None
        else:
            cron = CronExpression.parse(str(cron_expression))
            # Une création à 10:00:30 pour "* * * * *" commence à 10:01,
            # jamais rétroactivement à 10:00.
            first = cron.next_after(current, zone)
            schedule_kind = "cron"
        schedule_id = str(uuid.uuid4())
        current_text = timestamp(current)
        with self.db.transaction(immediate=True) as connection:
            connection.execute(
                """
                INSERT INTO mission_schedules(
                    id,name,state,schedule_kind,run_at,cron_expression,timezone,
                    catch_up_policy,max_catch_up,max_concurrency,
                    misfire_grace_seconds,mission_template_json,next_run_at,
                    created_at,updated_at
                ) VALUES (?,?, 'active', ?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    schedule_id,
                    name,
                    schedule_kind,
                    timestamp(first) if run_at is not None else None,
                    cron_expression,
                    timezone,
                    catch_up_policy,
                    max_catch_up,
                    max_concurrency,
                    misfire_grace_seconds,
                    canonical_json(template),
                    timestamp(first),
                    current_text,
                    current_text,
                ),
            )
        return self.get(schedule_id)

    def get(self, schedule_id: str) -> dict[str, Any]:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT * FROM mission_schedules WHERE id=?", (schedule_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(schedule_id)
        return self._schedule(row)

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM mission_schedules ORDER BY created_at DESC LIMIT ?",
                (max(1, min(limit, 200)),),
            ).fetchall()
        return [self._schedule(row) for row in rows]

    def history(self, schedule_id: str, limit: int = 100) -> list[dict[str, Any]]:
        self.get(schedule_id)
        with self.db.connect() as connection:
            rows = connection.execute(
                """
                SELECT id,schedule_id,scheduled_for,state,mission_id,error_code,
                       created_at,updated_at,started_at,finished_at
                FROM schedule_runs WHERE schedule_id=?
                ORDER BY scheduled_for DESC LIMIT ?
                """,
                (schedule_id, max(1, min(limit, 500))),
            ).fetchall()
        return [dict(row) for row in rows]

    def pause(self, schedule_id: str) -> dict[str, Any]:
        schedule = self.get(schedule_id)
        if schedule["state"] == "completed":
            raise ConflictError("a completed one-shot schedule cannot be paused")
        return self._set_state(schedule_id, "paused")

    def resume(self, schedule_id: str) -> dict[str, Any]:
        schedule = self.get(schedule_id)
        if schedule["state"] == "completed":
            raise ConflictError("a completed one-shot schedule cannot be resumed")
        return self._set_state(schedule_id, "active")

    def _set_state(self, schedule_id: str, state: str) -> dict[str, Any]:
        with self.db.transaction(immediate=True) as connection:
            changed = connection.execute(
                """
                UPDATE mission_schedules SET state=?,updated_at=?
                WHERE id=? AND state<>'completed'
                """,
                (state, timestamp(), schedule_id),
            ).rowcount
        if not changed:
            current = self.get(schedule_id)
            if current["state"] == "completed":
                raise ConflictError("a completed one-shot schedule cannot change state")
            raise NotFoundError(schedule_id)
        return self.get(schedule_id)

    def materialize_due(self, now: datetime | None = None) -> int:
        current = _utc(now or datetime.now(UTC))
        current_text = timestamp(current)
        with self.db.transaction(immediate=True) as connection:
            rows = connection.execute(
                """
                SELECT * FROM mission_schedules
                WHERE state='active' AND next_run_at IS NOT NULL AND next_run_at<=?
                ORDER BY next_run_at,id
                """,
                (current_text,),
            ).fetchall()
            created = 0
            for row in rows:
                created += self._materialize_schedule(connection, row, current)
            return created

    def _materialize_schedule(self, connection: Any, row: Any, now: datetime) -> int:
        due = datetime.fromisoformat(row["next_run_at"]).astimezone(UTC)
        policy = str(row["catch_up_policy"])
        grace = timedelta(seconds=int(row["misfire_grace_seconds"]))
        selected: list[datetime] = []
        skipped: list[tuple[datetime, str]] = []

        if row["schedule_kind"] == "one_shot":
            if policy == "skip" and due < now - grace:
                skipped.append((due, "misfire_skipped"))
            else:
                selected.append(due)
            next_run = None
            next_state = "completed"
        else:
            zone = self._timezone(str(row["timezone"]))
            cron = CronExpression.parse(str(row["cron_expression"]))
            if policy == "skip":
                if due < now - grace:
                    skipped.append((due, "misfire_skipped"))
                    next_run = cron.next_after(now, zone)
                else:
                    selected.append(due)
                    next_run = cron.next_after(due, zone)
            elif policy == "latest":
                latest = cron.previous_at_or_before(now, zone)
                if latest > due:
                    skipped.append((due, "superseded_by_latest"))
                selected.append(latest)
                next_run = cron.next_after(now, zone)
            else:
                latest_first: list[datetime] = []
                cursor = cron.previous_at_or_before(now, zone)
                for _ in range(int(row["max_catch_up"])):
                    if cursor < due:
                        break
                    latest_first.append(cursor)
                    cursor = self._previous(cron, cursor, zone)
                selected = list(reversed(latest_first))
                if selected and selected[0] > due:
                    skipped.append((due, "catch_up_limit"))
                next_run = cron.next_after(now, zone)
            next_state = "active"

        for scheduled_for, reason in skipped:
            created = timestamp(now)
            connection.execute(
                """
                INSERT OR IGNORE INTO schedule_runs(
                    id,schedule_id,scheduled_for,state,error_code,
                    created_at,updated_at,finished_at
                ) VALUES (?,?,?,'skipped',?,?,?,?)
                """,
                (
                    str(uuid.uuid4()),
                    row["id"],
                    timestamp(scheduled_for),
                    reason,
                    created,
                    created,
                    created,
                ),
            )
        inserted = 0
        for scheduled_for in selected:
            created = timestamp(now)
            inserted += connection.execute(
                """
                INSERT OR IGNORE INTO schedule_runs(
                    id,schedule_id,scheduled_for,state,created_at,updated_at
                ) VALUES (?,?,?,'pending',?,?)
                """,
                (
                    str(uuid.uuid4()),
                    row["id"],
                    timestamp(scheduled_for),
                    created,
                    created,
                ),
            ).rowcount
        last = selected[-1] if selected else (skipped[-1][0] if skipped else due)
        connection.execute(
            """
            UPDATE mission_schedules
            SET state=?,next_run_at=?,last_scheduled_at=?,updated_at=?
            WHERE id=?
            """,
            (
                next_state,
                timestamp(next_run) if next_run is not None else None,
                timestamp(last),
                timestamp(now),
                row["id"],
            ),
        )
        return inserted

    @staticmethod
    def _previous(cron: CronExpression, value: datetime, zone: ZoneInfo) -> datetime:
        return cron.previous_at_or_before(value - timedelta(minutes=1), zone)

    def reconcile(self) -> int:
        current = timestamp()
        with self.db.transaction(immediate=True) as connection:
            rows = connection.execute(
                """
                SELECT sr.id,m.state FROM schedule_runs sr
                JOIN missions m ON m.id=sr.mission_id
                WHERE sr.state='submitted' AND m.state IN ('succeeded','failed','cancelled')
                """
            ).fetchall()
            for row in rows:
                connection.execute(
                    """
                    UPDATE schedule_runs SET state=?,updated_at=?,finished_at=?
                    WHERE id=? AND state='submitted'
                    """,
                    (row["state"], current, current, row["id"]),
                )
            return len(rows)

    def claim(self, worker_id: str, lease_seconds: int = 30) -> ScheduleLease | None:
        now = datetime.now(UTC)
        current = timestamp(now)
        expires = timestamp(now + timedelta(seconds=lease_seconds))
        with self.db.transaction(immediate=True) as connection:
            row = connection.execute(
                """
                SELECT sr.*,s.mission_template_json,s.max_concurrency
                FROM schedule_runs sr
                JOIN mission_schedules s ON s.id=sr.schedule_id
                WHERE (
                    sr.state='pending'
                    OR (sr.state='claimed' AND sr.lease_expires_at<=?)
                )
                AND s.state<>'paused'
                AND (
                    SELECT COUNT(*) FROM schedule_runs active
                    WHERE active.schedule_id=sr.schedule_id
                      AND (
                          active.state='submitted'
                          OR (active.state='claimed' AND active.lease_expires_at>?)
                      )
                ) < s.max_concurrency
                ORDER BY sr.scheduled_for,sr.id LIMIT 1
                """,
                (current, current),
            ).fetchone()
            if row is None:
                return None
            token = secrets.token_urlsafe(24)
            changed = connection.execute(
                """
                UPDATE schedule_runs
                SET state='claimed',lease_owner=?,lease_token=?,lease_expires_at=?,
                    started_at=COALESCE(started_at,?),updated_at=?
                WHERE id=? AND (state='pending' OR (state='claimed' AND lease_expires_at<=?))
                """,
                (worker_id, token, expires, current, current, row["id"], current),
            ).rowcount
            if not changed:
                return None
            return ScheduleLease(
                run_id=str(row["id"]),
                schedule_id=str(row["schedule_id"]),
                scheduled_for=str(row["scheduled_for"]),
                mission_template=json.loads(row["mission_template_json"]),
                lease_owner=worker_id,
                lease_token=token,
            )

    def submit_claim(self, lease: ScheduleLease) -> str:
        plan = dict(lease.mission_template)
        plan["external_key"] = self._external_key(
            str(plan["external_key"]), lease.schedule_id, lease.scheduled_for
        )
        idempotency_key = f"schedule:{lease.schedule_id}:{lease.scheduled_for}"
        try:
            mission_id, _ = self.missions.submit(plan, idempotency_key)
        except (ValidationError, ConflictError) as exc:
            # Ces deux erreurs décrivent le contenu durable du calendrier : un
            # profil retiré entre-temps, ou une collision incohérente. Les
            # rejouer ne les réparera pas. Les erreurs d'infrastructure, elles,
            # laissent volontairement le bail expirer afin qu'une autre
            # instance reprenne l'occurrence.
            self.fail_claim(lease, f"submission_{type(exc).__name__}")
            raise
        with self.db.transaction(immediate=True) as connection:
            changed = connection.execute(
                """
                UPDATE schedule_runs
                SET state='submitted',mission_id=?,lease_owner=NULL,lease_token=NULL,
                    lease_expires_at=NULL,updated_at=?
                WHERE id=? AND state='claimed' AND lease_owner=? AND lease_token=?
                """,
                (
                    mission_id,
                    timestamp(),
                    lease.run_id,
                    lease.lease_owner,
                    lease.lease_token,
                ),
            ).rowcount
        if not changed:
            # La soumission est idempotente ; perdre le bail n'autorise pas ce
            # worker à publier son résultat. Le prochain claim retrouvera la
            # même mission avec la même clé puis conclura la ligne.
            raise LeaseLostError(lease.run_id)
        return mission_id

    def fail_claim(self, lease: ScheduleLease, error_code: str) -> None:
        with self.db.transaction(immediate=True) as connection:
            changed = connection.execute(
                """
                UPDATE schedule_runs
                SET state='failed',error_code=?,lease_owner=NULL,lease_token=NULL,
                    lease_expires_at=NULL,updated_at=?,finished_at=?
                WHERE id=? AND state='claimed' AND lease_owner=? AND lease_token=?
                """,
                (
                    error_code[:128],
                    timestamp(),
                    timestamp(),
                    lease.run_id,
                    lease.lease_owner,
                    lease.lease_token,
                ),
            ).rowcount
        if not changed:
            raise LeaseLostError(lease.run_id)

    @staticmethod
    def _external_key(base: str, schedule_id: str, scheduled_for: str) -> str:
        compact = scheduled_for.replace("-", "").replace(":", "").replace("+00:00", "Z")
        suffix = f":{schedule_id[:8]}:{compact}"
        if len(base) + len(suffix) <= 128:
            return base + suffix
        digest = hashlib.sha256(f"{schedule_id}:{scheduled_for}".encode()).hexdigest()[
            :16
        ]
        return f"{base[:110]}:{digest}"

    @staticmethod
    def _schedule(row: Any) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "state": row["state"],
            "schedule_kind": row["schedule_kind"],
            "run_at": row["run_at"],
            "cron_expression": row["cron_expression"],
            "timezone": row["timezone"],
            "catch_up_policy": row["catch_up_policy"],
            "max_catch_up": row["max_catch_up"],
            "max_concurrency": row["max_concurrency"],
            "misfire_grace_seconds": row["misfire_grace_seconds"],
            "mission": json.loads(row["mission_template_json"]),
            "next_run_at": row["next_run_at"],
            "last_scheduled_at": row["last_scheduled_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


@dataclass
class Scheduler:
    repository: SchedulerRepository
    worker_id: str = "scheduler-local"
    lease_seconds: int = 30

    def run_once(self, now: datetime | None = None) -> bool:
        self.repository.reconcile()
        materialized = self.repository.materialize_due(now)
        lease = self.repository.claim(self.worker_id, self.lease_seconds)
        if lease is None:
            return materialized > 0
        self.repository.submit_claim(lease)
        return True
