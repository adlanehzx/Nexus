from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from nexus_engine.database import Database
from nexus_engine.domain import MissionOwner
from nexus_engine.errors import ConflictError, ValidationError
from nexus_engine.repository import MissionRepository
from nexus_engine.scheduler import CronExpression, Scheduler, SchedulerRepository


def plan(external_key: str = "scheduled-demo") -> dict:
    return {
        "external_key": external_key,
        "title": "Scheduled demo",
        "workspace": "/tmp/workspace",
        "defaults": {"profile": "codex"},
        "tasks": [{"key": "one", "instruction": "Do one", "depends_on": []}],
    }


@pytest.fixture
def repositories(tmp_path):
    missions = MissionRepository(Database(tmp_path / "scheduler.db"))
    missions.register_profile("codex", "profile-codex")
    return missions, SchedulerRepository(missions.db, missions)


def create_cron(
    schedules: SchedulerRepository,
    *,
    now: datetime,
    policy: str = "all",
    max_catch_up: int = 3,
    max_concurrency: int = 1,
) -> dict:
    return schedules.create(
        name="Every minute",
        mission=plan(),
        timezone="UTC",
        run_at=None,
        cron_expression="* * * * *",
        catch_up_policy=policy,
        max_catch_up=max_catch_up,
        max_concurrency=max_concurrency,
        misfire_grace_seconds=30,
        now=now,
    )


def test_cron_uses_named_timezone_across_dst() -> None:
    cron = CronExpression.parse("0 9 * * 1-5")
    paris = ZoneInfo("Europe/Paris")

    winter = cron.next_after(datetime(2026, 1, 4, 12, tzinfo=UTC), paris)
    summer = cron.next_after(datetime(2026, 7, 5, 12, tzinfo=UTC), paris)

    assert winter == datetime(2026, 1, 5, 8, tzinfo=UTC)
    assert summer == datetime(2026, 7, 6, 7, tzinfo=UTC)


@pytest.mark.parametrize("expression", ["* * *", "61 * * * *", "*/0 * * * *"])
def test_invalid_cron_is_rejected(expression: str) -> None:
    with pytest.raises(ValidationError):
        CronExpression.parse(expression)


def test_one_shot_is_materialized_submitted_and_reconciled(repositories) -> None:
    missions, schedules = repositories
    due = datetime(2026, 1, 2, 10, tzinfo=UTC)
    schedule = schedules.create(
        name="Once",
        mission=plan(),
        timezone="Europe/Paris",
        run_at=due,
        cron_expression=None,
        catch_up_policy="latest",
        max_catch_up=1,
        max_concurrency=1,
        misfire_grace_seconds=0,
        now=due - timedelta(days=1),
    )

    assert schedules.materialize_due(due) == 1
    lease = schedules.claim("scheduler-a")
    assert lease is not None
    mission_id = schedules.submit_claim(lease)
    assert schedules.get(schedule["id"])["state"] == "completed"
    assert schedules.history(schedule["id"])[0]["state"] == "submitted"

    with missions.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE missions SET state='succeeded' WHERE id=?", (mission_id,)
        )
    assert schedules.reconcile() == 1
    assert schedules.history(schedule["id"])[0]["state"] == "succeeded"


def test_submission_is_idempotent_after_dispatcher_crash(repositories) -> None:
    missions, schedules = repositories
    due = datetime(2026, 2, 1, tzinfo=UTC)
    schedule = schedules.create(
        name="Crash safe",
        mission=plan(),
        timezone="UTC",
        run_at=due,
        cron_expression=None,
        catch_up_policy="latest",
        max_catch_up=1,
        max_concurrency=1,
        misfire_grace_seconds=0,
        now=due - timedelta(days=1),
    )
    schedules.materialize_due(due)
    first = schedules.claim("scheduler-a", lease_seconds=30)
    assert first is not None

    # Le processus soumet la mission puis meurt avant de conclure le run.
    submitted = dict(first.mission_template)
    submitted["external_key"] = schedules._external_key(
        submitted["external_key"], first.schedule_id, first.scheduled_for
    )
    first_mission, replayed = missions.submit(
        submitted, f"schedule:{first.schedule_id}:{first.scheduled_for}"
    )
    assert replayed is False
    with missions.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE schedule_runs SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (first.run_id,),
        )

    recovered = schedules.claim("scheduler-b")
    assert recovered is not None and recovered.run_id == first.run_id
    assert schedules.submit_claim(recovered) == first_mission
    assert len(missions.missions(10)) == 1
    assert schedules.history(schedule["id"])[0]["state"] == "submitted"


def test_transient_submission_failure_is_retried_after_lease(
    repositories, monkeypatch
) -> None:
    missions, schedules = repositories
    due = datetime(2026, 2, 2, tzinfo=UTC)
    schedules.create(
        name="Transient failure",
        mission=plan(),
        timezone="UTC",
        run_at=due,
        cron_expression=None,
        catch_up_policy="latest",
        max_catch_up=1,
        max_concurrency=1,
        misfire_grace_seconds=0,
        now=due - timedelta(days=1),
    )
    schedules.materialize_due(due)
    lease = schedules.claim("scheduler-a")
    assert lease is not None
    submit = missions.submit
    monkeypatch.setattr(
        missions,
        "submit",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            sqlite3.OperationalError("busy")
        ),
    )
    with pytest.raises(sqlite3.OperationalError):
        schedules.submit_claim(lease)
    assert schedules.history(lease.schedule_id)[0]["state"] == "claimed"

    monkeypatch.setattr(missions, "submit", submit)
    with missions.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE schedule_runs SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (lease.run_id,),
        )
    recovered = schedules.claim("scheduler-b")
    assert recovered is not None
    schedules.submit_claim(recovered)
    assert schedules.history(lease.schedule_id)[0]["state"] == "submitted"


def test_all_catch_up_is_bounded_and_keeps_latest_occurrences(repositories) -> None:
    _, schedules = repositories
    start = datetime(2026, 3, 1, 0, 0, tzinfo=UTC)
    schedule = create_cron(schedules, now=start, policy="all", max_catch_up=3)

    assert schedules.materialize_due(start + timedelta(minutes=10)) == 3
    history = schedules.history(schedule["id"])
    pending = sorted(
        run["scheduled_for"] for run in history if run["state"] == "pending"
    )
    assert pending == [
        "2026-03-01T00:08:00.000000+00:00",
        "2026-03-01T00:09:00.000000+00:00",
        "2026-03-01T00:10:00.000000+00:00",
    ]
    assert any(
        run["state"] == "skipped" and run["error_code"] == "catch_up_limit"
        for run in history
    )
    assert schedules.get(schedule["id"])["next_run_at"] == (
        "2026-03-01T00:11:00.000000+00:00"
    )


def test_latest_and_skip_have_explicit_misfire_history(repositories) -> None:
    _, schedules = repositories
    start = datetime(2026, 4, 1, tzinfo=UTC)
    latest = create_cron(schedules, now=start, policy="latest")
    skipped = create_cron(schedules, now=start, policy="skip")
    late = start + timedelta(minutes=10)

    assert schedules.materialize_due(late) == 1
    latest_history = schedules.history(latest["id"])
    assert {run["state"] for run in latest_history} == {"pending", "skipped"}
    assert (
        next(run for run in latest_history if run["state"] == "pending")[
            "scheduled_for"
        ]
        == "2026-04-01T00:10:00.000000+00:00"
    )
    skip_history = schedules.history(skipped["id"])
    assert len(skip_history) == 1
    assert skip_history[0]["error_code"] == "misfire_skipped"


def test_pause_resume_preserves_due_time_and_applies_catchup(repositories) -> None:
    _, schedules = repositories
    start = datetime(2026, 5, 1, tzinfo=UTC)
    schedule = create_cron(schedules, now=start, policy="latest")
    schedules.pause(schedule["id"])

    assert schedules.materialize_due(start + timedelta(hours=1)) == 0
    resumed = schedules.resume(schedule["id"])
    assert resumed["next_run_at"] == "2026-05-01T00:01:00.000000+00:00"
    assert schedules.materialize_due(start + timedelta(hours=1)) == 1


def test_pause_stops_an_already_materialized_occurrence(repositories) -> None:
    _, schedules = repositories
    start = datetime(2026, 5, 2, tzinfo=UTC)
    schedule = create_cron(schedules, now=start, policy="latest")
    schedules.materialize_due(start + timedelta(minutes=1))
    schedules.pause(schedule["id"])
    assert schedules.claim("scheduler") is None
    schedules.resume(schedule["id"])
    assert schedules.claim("scheduler") is not None


def test_completed_one_shot_cannot_resume(repositories) -> None:
    _, schedules = repositories
    due = datetime(2026, 6, 1, tzinfo=UTC)
    schedule = schedules.create(
        name="Once",
        mission=plan(),
        timezone="UTC",
        run_at=due,
        cron_expression=None,
        catch_up_policy="skip",
        max_catch_up=1,
        max_concurrency=1,
        misfire_grace_seconds=0,
        now=due - timedelta(days=1),
    )
    schedules.materialize_due(due + timedelta(seconds=1))
    with pytest.raises(ConflictError):
        schedules.pause(schedule["id"])
    with pytest.raises(ConflictError):
        schedules.resume(schedule["id"])


def test_per_schedule_concurrency_waits_for_previous_mission(repositories) -> None:
    missions, schedules = repositories
    start = datetime(2026, 7, 1, tzinfo=UTC)
    create_cron(schedules, now=start, policy="all", max_catch_up=2, max_concurrency=1)
    schedules.materialize_due(start + timedelta(minutes=2))
    first = schedules.claim("scheduler-a")
    assert first is not None
    mission_id = schedules.submit_claim(first)
    assert schedules.claim("scheduler-b") is None

    with missions.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE missions SET state='succeeded' WHERE id=?", (mission_id,)
        )
    schedules.reconcile()
    assert schedules.claim("scheduler-b") is not None


def test_scheduler_tick_dispatches_due_work(repositories) -> None:
    missions, schedules = repositories
    due = datetime(2026, 8, 1, tzinfo=UTC)
    schedules.create(
        name="Tick",
        mission=plan(),
        timezone="UTC",
        run_at=due,
        cron_expression=None,
        catch_up_policy="latest",
        max_catch_up=1,
        max_concurrency=1,
        misfire_grace_seconds=0,
        now=due - timedelta(days=1),
    )

    assert Scheduler(schedules).run_once(due) is True
    assert len(missions.missions(10)) == 1


def test_schedule_rejects_unknown_timezone_and_persisted_owner(repositories) -> None:
    _, schedules = repositories
    due = datetime(2026, 9, 1, tzinfo=UTC)
    with pytest.raises(ValidationError, match="unknown timezone"):
        schedules.create(
            name="Bad timezone",
            mission=plan(),
            timezone="Mars/Olympus",
            run_at=due,
            cron_expression=None,
            catch_up_policy="latest",
            max_catch_up=1,
            max_concurrency=1,
            misfire_grace_seconds=0,
        )

    owned = plan()
    owned["owner"] = {"user_id": "user", "assertion": "signed-value"}
    with pytest.raises(ValidationError, match="owner assertion"):
        schedules.create(
            name="Unsafe owner",
            mission=owned,
            timezone="UTC",
            run_at=due,
            cron_expression=None,
            catch_up_policy="latest",
            max_catch_up=1,
            max_concurrency=1,
            misfire_grace_seconds=0,
        )


def test_scheduled_agent_core_exchanges_delegation_just_in_time(tmp_path) -> None:
    missions = MissionRepository(Database(tmp_path / "scheduled-core.db"))

    class Grants:
        calls: list[dict] = []

        def exchange(self, **values):  # noqa: ANN003, ANN201
            self.calls.append(values)
            return MissionOwner(
                user_id="user-1",
                assertion="short-lived-assertion",
                expires_at="2030-01-02T00:00:00+00:00",
            )

    grants = Grants()
    schedules = SchedulerRepository(missions.db, missions, grants)  # type: ignore[arg-type]
    due = datetime(2030, 1, 1, 7, tzinfo=UTC)
    schedule = schedules.create(
        name="Agent Core",
        mission={
            "external_key": "nexus-scheduled-core",
            "title": "Agent Core",
            "workspace": "/tmp/workspace",
            "tasks": [
                {
                    "key": "synthesis",
                    "profile": "agent-core",
                    "agent_kind": "agent-core",
                    "instruction": "Synthétise",
                }
            ],
        },
        timezone="UTC",
        run_at=due,
        cron_expression=None,
        catch_up_policy="latest",
        max_catch_up=1,
        max_concurrency=1,
        misfire_grace_seconds=0,
        schedule_id="22222222-2222-4222-8222-222222222222",
        owner_delegation="nsg_" + "x" * 43,
        now=due - timedelta(days=1),
    )
    assert "owner_delegation" not in schedule
    assert "nsg_" not in str(schedule)

    schedules.materialize_due(due)
    lease = schedules.claim("scheduler")
    assert lease is not None
    mission_id = schedules.submit_claim(lease)

    assert grants.calls == [
        {
            "delegation": "nsg_" + "x" * 43,
            "schedule_id": schedule["id"],
            "scheduled_for": "2030-01-01T07:00:00.000000+00:00",
            "mission_external_key": (
                "nexus-scheduled-core:22222222:20300101T070000.000000+0000"
            ),
        }
    ]
    with missions.db.connect() as connection:
        stored = connection.execute(
            "SELECT owner_user_id,owner_assertion,definition_json FROM missions WHERE id=?",
            (mission_id,),
        ).fetchone()
    assert stored["owner_user_id"] == "user-1"
    assert stored["owner_assertion"] == "short-lived-assertion"
    assert "short-lived-assertion" not in stored["definition_json"]


def test_scheduled_agent_core_requires_delegation(repositories) -> None:
    _, schedules = repositories
    with pytest.raises(ValidationError, match="owner delegation"):
        schedules.create(
            name="Unsafe",
            mission={
                "external_key": "unsafe",
                "title": "Unsafe",
                "workspace": "/tmp/workspace",
                "tasks": [
                    {
                        "key": "one",
                        "profile": "agent-core",
                        "agent_kind": "agent-core",
                        "instruction": "Go",
                    }
                ],
            },
            timezone="UTC",
            run_at=datetime(2030, 1, 1, tzinfo=UTC),
            cron_expression=None,
            catch_up_policy="latest",
            max_catch_up=1,
            max_concurrency=1,
            misfire_grace_seconds=0,
        )
