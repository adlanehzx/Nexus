# NEXUS Mission Engine

Durable local engine for NEXUS. It manages the mission queue, task dependencies,
leases, crash recovery, routing between ACP profiles, quality control, and the
simulation ledger. Agent execution turns are handled by the native ACP runtime
located in `services/agent`.

The service accepts no provider secrets. ACP adapters strictly reuse local
authentications from their respective CLIs.

## Durable Scheduling

The scheduler stores schedules and occurrences in the same SQLite database as
missions. It accepts a one-off timestamp (`run_at`) or a 5-field cron expression
(`cron_expression`), always paired with an explicit IANA timezone like
`Europe/Paris`. An occurrence is submitted using an idempotency key derived from
the schedule and its scheduled timestamp: a restart between submission and
registration therefore never creates a duplicate mission.

```json
POST /v1/schedules
{
  "name": "Daily Intelligence",
  "timezone": "Europe/Paris",
  "cron_expression": "0 8 * * 1-5",
  "catch_up_policy": "latest",
  "max_catch_up": 3,
  "max_concurrency": 1,
  "misfire_grace_seconds": 300,
  "mission": {
    "external_key": "daily-watch",
    "title": "Daily Intelligence",
    "workspace": "/workspace",
    "defaults": {"profile": "codex"},
    "tasks": [{"key": "watch", "instruction": "Produce intelligence summary.", "depends_on": []}]
  }
}
```

Catch-up policies include:

- `skip`: ignores any occurrence older than the configured grace window;
- `latest`: only executes the most recent missed occurrence;
- `all`: replays up to `max_catch_up` missed occurrences, starting from the most recent.

`POST /v1/schedules/{id}/pause` and `/resume` control a schedule without losing
its next calculated trigger time. `GET /v1/schedules/{id}/runs` provides execution
history and links to each generated mission. `max_concurrency` caps non-terminated
missions belonging to the same schedule.

The dispatcher is active by default. It can be configured using
`NEXUS_ENGINE_SCHEDULER_ENABLED` and `NEXUS_ENGINE_SCHEDULER_POLL_SECONDS`.
An Agent Core owner assertion, which expires and must not become a long-lived secret,
is rejected when creating a schedule. For an `agent-core` task, the API instead
provides an opaque and revocable schedule delegation. Immediately prior to each
occurrence, the engine exchanges this delegation for a short-lived assertion whose
exact scope is recalculated by the API. The browser can neither supply nor inspect
this delegation.

## Verification

```bash
uv sync --extra dev
uv run pytest
```

