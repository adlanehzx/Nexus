from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
    profile_key TEXT PRIMARY KEY,
    agent_profile_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    -- Executor for this profile: 'acp' launches per-process agent,
    -- 'agent-core' delegates to Agent Core via API.
    agent_kind TEXT NOT NULL DEFAULT 'acp' CHECK (agent_kind IN ('acp', 'agent-core'))
);

CREATE TABLE IF NOT EXISTS profile_health (
    profile_key TEXT PRIMARY KEY REFERENCES profiles(profile_key) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (
        status IN ('available','degraded','cooldown','quota_exhausted','auth_required','unknown')
    ),
    cooldown_until TEXT,
    remaining_5h_percent INTEGER CHECK (
        remaining_5h_percent IS NULL OR remaining_5h_percent BETWEEN 0 AND 100
    ),
    remaining_week_percent INTEGER CHECK (
        remaining_week_percent IS NULL OR remaining_week_percent BETWEEN 0 AND 100
    ),
    resets_5h_at TEXT,
    resets_week_at TEXT,
    usage_source TEXT NOT NULL DEFAULT 'unknown',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error_category TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    external_key TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    workspace TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    -- Signed mission owner from API.
    owner_user_id TEXT,
    -- Signed assertion for API delegation.
    owner_assertion TEXT,
    -- Assertion expiration time.
    owner_assertion_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    task_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    profile_key TEXT NOT NULL REFERENCES profiles(profile_key),
    agent_profile_id TEXT NOT NULL,
    instruction TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('blocked','ready','running','retry_wait','awaiting_confirmation','succeeded','failed','cancelled','skipped')),
    timeout_seconds INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    retry_delay_seconds INTEGER NOT NULL,
    fallback_profiles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fallback_profiles_json)),
    context_budget_chars INTEGER NOT NULL DEFAULT 60000,
    -- Conversation opened by Agent Core on first attempt, reused on subsequent retries.
    agent_core_conversation_id TEXT,
    -- Agent Core run awaiting confirmation.
    agent_core_run_id TEXT,
    agent_core_confirmation_id TEXT,
    next_attempt_at TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (mission_id, task_key)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('leased','creating','running','awaiting_confirmation','succeeded','failed','timed_out','cancelled','orphaned')),
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    conversation_id TEXT NOT NULL UNIQUE,
    event_cursor TEXT,
    final_response_json TEXT CHECK (final_response_json IS NULL OR json_valid(final_response_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (task_id, attempt_no)
    ,CHECK (
        (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
        OR
        (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    received_at TEXT NOT NULL,
    UNIQUE (attempt_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    available_at TEXT NOT NULL,
    delivered_at TEXT,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_schedulable ON tasks(state, next_attempt_at, mission_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_attempts_lease ON attempts(state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at, available_at);

CREATE TABLE IF NOT EXISTS routing_decisions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    selected_profile TEXT,
    candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json)),
    observations_json TEXT NOT NULL CHECK (json_valid(observations_json)),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_decisions_task
    ON routing_decisions(task_id, created_at);

CREATE TABLE IF NOT EXISTS mission_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active','paused','completed')),
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('one_shot','cron')),
    run_at TEXT,
    cron_expression TEXT,
    timezone TEXT NOT NULL,
    catch_up_policy TEXT NOT NULL CHECK (catch_up_policy IN ('skip','latest','all')),
    max_catch_up INTEGER NOT NULL CHECK (max_catch_up BETWEEN 1 AND 100),
    max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 32),
    misfire_grace_seconds INTEGER NOT NULL CHECK (misfire_grace_seconds BETWEEN 0 AND 86400),
    mission_template_json TEXT NOT NULL CHECK (json_valid(mission_template_json)),
    owner_delegation TEXT,
    next_run_at TEXT,
    last_scheduled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (schedule_kind='one_shot' AND run_at IS NOT NULL AND cron_expression IS NULL)
        OR
        (schedule_kind='cron' AND run_at IS NULL AND cron_expression IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES mission_schedules(id) ON DELETE CASCADE,
    scheduled_for TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('pending','claimed','submitted','succeeded','failed','cancelled','skipped')
    ),
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    mission_id TEXT REFERENCES missions(id),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (schedule_id, scheduled_for),
    CHECK (
        (state='claimed' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
                         AND lease_expires_at IS NOT NULL)
        OR
        (state<>'claimed' AND lease_owner IS NULL AND lease_token IS NULL
                          AND lease_expires_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_mission_schedules_due
    ON mission_schedules(state, next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_dispatch
    ON schedule_runs(state, lease_expires_at, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_history
    ON schedule_runs(schedule_id, scheduled_for DESC);

CREATE TABLE IF NOT EXISTS paper_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency='EUR'),
    initial_balance_cents INTEGER NOT NULL CHECK (initial_balance_cents>0),
    cash_balance_cents INTEGER NOT NULL CHECK (cash_balance_cents>=0),
    realized_pnl_cents INTEGER NOT NULL DEFAULT 0,
    risk_policy_json TEXT NOT NULL CHECK (json_valid(risk_policy_json)),
    live_trading INTEGER NOT NULL DEFAULT 0 CHECK (live_trading=0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_markets (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    close_at TEXT NOT NULL,
    venue TEXT NOT NULL CHECK (venue='paper'),
    state TEXT NOT NULL CHECK (state IN ('open','settled','cancelled')),
    winning_outcome TEXT CHECK (winning_outcome IS NULL OR winning_outcome IN ('yes','no')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_quotes (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL REFERENCES paper_markets(id),
    yes_price_ppm INTEGER NOT NULL CHECK (yes_price_ppm BETWEEN 10000 AND 990000),
    liquidity_cents INTEGER NOT NULL CHECK (liquidity_cents>=0),
    source_url TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_orders (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL REFERENCES paper_accounts(id),
    market_id TEXT NOT NULL REFERENCES paper_markets(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('yes','no')),
    stake_cents INTEGER NOT NULL CHECK (stake_cents>0),
    fee_cents INTEGER NOT NULL CHECK (fee_cents>=0),
    execution_price_ppm INTEGER NOT NULL CHECK (execution_price_ppm BETWEEN 1 AND 999999),
    shares_micro INTEGER NOT NULL CHECK (shares_micro>0),
    model_probability_ppm INTEGER NOT NULL CHECK (model_probability_ppm BETWEEN 1 AND 999999),
    confidence_ppm INTEGER NOT NULL CHECK (confidence_ppm BETWEEN 1 AND 1000000),
    state TEXT NOT NULL CHECK (state IN ('filled','settled','voided')),
    payout_cents INTEGER,
    created_at TEXT NOT NULL,
    settled_at TEXT
);

CREATE TABLE IF NOT EXISTS risk_decisions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES paper_accounts(id),
    market_id TEXT NOT NULL REFERENCES paper_markets(id),
    allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
    proposed_stake_cents INTEGER NOT NULL CHECK (proposed_stake_cents>=0),
    reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
    inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    previous_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL UNIQUE REFERENCES missions(id),
    account_id TEXT NOT NULL REFERENCES paper_accounts(id),
    market_id TEXT NOT NULL REFERENCES paper_markets(id),
    allowed_sources_json TEXT NOT NULL CHECK (json_valid(allowed_sources_json)),
    state TEXT NOT NULL CHECK (state IN ('running','waiting_market_data','executed','abstained','failed')),
    decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
    paper_result_json TEXT CHECK (paper_result_json IS NULL OR json_valid(paper_result_json)),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_quotes_market_time ON paper_quotes(market_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_account_state ON paper_orders(account_id, state);
CREATE INDEX IF NOT EXISTS idx_risk_decisions_account_time ON risk_decisions(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_research_runs_state ON research_runs(state, updated_at);

CREATE TABLE IF NOT EXISTS mission_artifacts (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content_base64 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes>=0),
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (mission_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mission_artifacts_mission
    ON mission_artifacts(mission_id, created_at);
"""


def table_ddl(name: str) -> str:
    """Extracts ``CREATE TABLE`` statement for a table from reference SCHEMA."""
    marker = f"CREATE TABLE IF NOT EXISTS {name} ("
    start = SCHEMA.index(marker)
    end = SCHEMA.index("\n);", start) + len("\n);")
    return SCHEMA[start:end]


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _widen_state_checks(self, connection: sqlite3.Connection) -> None:
        """Adds ``awaiting_confirmation`` to CHECK constraints of ``tasks`` and ``attempts``."""
        for table in ("tasks", "attempts"):
            existing = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if existing is None or "awaiting_confirmation" in str(existing["sql"]):
                continue

            target = table_ddl(table).replace(
                f"CREATE TABLE IF NOT EXISTS {table} (",
                f"CREATE TABLE {table}__migrating (",
                1,
            )
            # Foreign keys disabled outside transaction so DROP TABLE succeeds.
            connection.execute("PRAGMA foreign_keys = OFF")
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(target)
                old_columns = [
                    row["name"]
                    for row in connection.execute(f"PRAGMA table_info({table})")
                ]
                new_columns = [
                    row["name"]
                    for row in connection.execute(
                        f"PRAGMA table_info({table}__migrating)"
                    )
                ]
                carried = [name for name in new_columns if name in old_columns]
                columns = ",".join(f'"{name}"' for name in carried)
                connection.execute(
                    f"INSERT INTO {table}__migrating ({columns}) "
                    f"SELECT {columns} FROM {table}"
                )
                connection.execute(f"DROP TABLE {table}")
                connection.execute(
                    f"ALTER TABLE {table}__migrating RENAME TO {table}"
                )
                violations = connection.execute("PRAGMA foreign_key_check").fetchall()
                if violations:
                    raise RuntimeError(
                        f"cannot migrate {table}: {len(violations)} foreign key violations"
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
            finally:
                connection.execute("PRAGMA foreign_keys = ON")

    def migrate(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            task_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(tasks)")
            }
            if "agent_profile_id" not in task_columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN agent_profile_id TEXT")
                connection.execute(
                    """
                    UPDATE tasks SET agent_profile_id=(
                        SELECT agent_profile_id FROM profiles
                        WHERE profiles.profile_key=tasks.profile_key
                    )
                    WHERE agent_profile_id IS NULL
                    """
                )
                missing = connection.execute(
                    "SELECT COUNT(*) FROM tasks WHERE agent_profile_id IS NULL"
                ).fetchone()[0]
                if missing:
                    raise RuntimeError(
                        "cannot migrate tasks: one or more profile mappings are missing"
                    )
            if "fallback_profiles_json" not in task_columns:
                connection.execute(
                    "ALTER TABLE tasks ADD COLUMN fallback_profiles_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "context_budget_chars" not in task_columns:
                connection.execute(
                    "ALTER TABLE tasks ADD COLUMN context_budget_chars INTEGER NOT NULL DEFAULT 60000"
                )
            if "agent_core_conversation_id" not in task_columns:
                connection.execute(
                    "ALTER TABLE tasks ADD COLUMN agent_core_conversation_id TEXT"
                )
            if "agent_core_run_id" not in task_columns:
                connection.execute("ALTER TABLE tasks ADD COLUMN agent_core_run_id TEXT")
            if "agent_core_confirmation_id" not in task_columns:
                connection.execute(
                    "ALTER TABLE tasks ADD COLUMN agent_core_confirmation_id TEXT"
                )
            profile_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(profiles)")
            }
            if "agent_kind" not in profile_columns:
                # Add agent_kind column for profiles if missing.
                connection.execute(
                    "ALTER TABLE profiles ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'acp'"
                )
            mission_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(missions)")
            }
            if "owner_user_id" not in mission_columns:
                connection.execute("ALTER TABLE missions ADD COLUMN owner_user_id TEXT")
            if "owner_assertion" not in mission_columns:
                connection.execute("ALTER TABLE missions ADD COLUMN owner_assertion TEXT")
            if "owner_assertion_expires_at" not in mission_columns:
                connection.execute(
                    "ALTER TABLE missions ADD COLUMN owner_assertion_expires_at TEXT"
                )
            outbox_columns = {
                row["name"] for row in connection.execute("PRAGMA table_info(outbox)")
            }
            for column in ("lease_owner", "lease_token", "lease_expires_at"):
                if column not in outbox_columns:
                    connection.execute(f"ALTER TABLE outbox ADD COLUMN {column} TEXT")
            # Apply state check migration and restore schema.
            self._widen_state_checks(connection)
            connection.executescript(SCHEMA)
            # Reserved profile for Agent Core executor.
            connection.execute(
                """
                INSERT INTO profiles(profile_key, agent_profile_id, enabled, agent_kind)
                VALUES ('agent-core', 'agent-core', 1, 'agent-core')
                ON CONFLICT(profile_key) DO UPDATE SET enabled=1, agent_kind='agent-core'
                """
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO profile_health(profile_key,updated_at)
                SELECT profile_key, strftime('%Y-%m-%dT%H:%M:%f+00:00','now') FROM profiles
                """
            )
            research_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(research_runs)")
            }
            if research_columns and "allowed_sources_json" not in research_columns:
                connection.execute(
                    "ALTER TABLE research_runs ADD COLUMN allowed_sources_json TEXT NOT NULL DEFAULT '[]'"
                )
            schedule_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(mission_schedules)")
            }
            if "owner_delegation" not in schedule_columns:
                connection.execute(
                    "ALTER TABLE mission_schedules ADD COLUMN owner_delegation TEXT"
                )

    @contextmanager
    def transaction(self, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            yield connection
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()
