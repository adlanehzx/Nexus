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
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
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
    state TEXT NOT NULL CHECK (state IN ('blocked','ready','running','retry_wait','succeeded','failed','cancelled','skipped')),
    timeout_seconds INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    retry_delay_seconds INTEGER NOT NULL,
    fallback_profiles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fallback_profiles_json)),
    context_budget_chars INTEGER NOT NULL DEFAULT 60000,
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
    state TEXT NOT NULL CHECK (state IN ('leased','creating','running','succeeded','failed','timed_out','cancelled','orphaned')),
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
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_schedulable ON tasks(state, next_attempt_at, mission_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_attempts_lease ON attempts(state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at, available_at);

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
"""


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
