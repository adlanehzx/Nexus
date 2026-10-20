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
    -- Quel exécutant sert ce profil. 'acp' lance un agent par processus, et
    -- 'agent-core' délègue à Agent Core via l'API. La colonne vit ici, et non
    -- sur la tâche, parce que le routage et les replis raisonnent déjà par
    -- profil : un repli entre deux exécutants de nature différente n'aurait pas
    -- de sens, et le dire au niveau du profil l'interdit par construction.
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
    -- Propriétaire de la mission, tel que l'API l'a signé. Jusqu'ici la
    -- propriété n'était portée que par un préfixe d'`external_key` : lisible,
    -- mais invérifiable — le moteur ne pouvait pas distinguer un préfixe
    -- légitime d'un préfixe recopié.
    owner_user_id TEXT,
    -- L'assertion signée elle-même. Le moteur ne sait pas la relire et n'a pas
    -- à le savoir : il la conserve et la rejoue. Elle ne sort jamais par l'API
    -- du moteur, n'entre dans aucun journal et n'est jamais donnée à un modèle.
    owner_assertion TEXT,
    -- Expiration de l'assertion, telle que l'API l'a annoncee. Le moteur ne
    -- sait pas relire le jeton -- il n'a pas la cle -- mais il doit savoir
    -- quand son assertion devient inutilisable, ne serait-ce que pour le dire
    -- dans un journal plutot que d'echouer sur une erreur de signature.
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
    -- Conversation ouverte par Agent Core au premier essai, réutilisée aux
    -- suivants. C'est ce qui fait qu'un retry prolonge un historique au lieu
    -- d'en ouvrir un second. Nulle pour toute tâche ACP.
    agent_core_conversation_id TEXT,
    -- Run Agent Core suspendu sur une confirmation humaine, et la confirmation
    -- attendue. Renseignes uniquement entre la suspension et la decision : le
    -- moteur s'en sert pour redemander ou en est le run, et c'est ce qui rend
    -- l'attente durable — elle survit a un redemarrage comme tout le reste.
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


def table_ddl(name: str) -> str:
    """Extrait du schéma de référence le ``CREATE TABLE`` d'une table.

    Une seule source de vérité. Recopier la définition ailleurs pour les besoins
    d'une reconstruction la ferait diverger du schéma d'une base neuve au
    premier changement suivant — et cette divergence ne se verrait que le jour
    où une contrainte manquerait sur l'une des deux.
    """
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
        """Ajoute ``awaiting_confirmation`` aux CHECK de ``tasks`` et ``attempts``.

        SQLite ne sait pas modifier une contrainte CHECK : il faut reconstruire
        la table. C'est la seule migration non additive de ce service, et elle
        est écrite pour être sûre plutôt que courte —

        - elle ne fait rien si la base porte déjà le nouvel état, donc elle est
          idempotente et ne coûte rien aux démarrages suivants ;
        - la table neuve vient de `SCHEMA`, pas d'une copie manuelle, donc une
          base migrée a exactement la structure d'une base neuve — au seul
          détail près que SQLite met le nom de la table entre guillemets après
          un `RENAME`, ce qui ne change ni les colonnes ni les contraintes ;
        - les colonnes copiées sont l'intersection des deux schémas, de sorte
          qu'une colonne ajoutée plus tard au schéma ne fasse pas échouer la
          copie d'une base qui ne l'a pas encore ;
        - `foreign_key_check` tourne avant de valider : si la copie avait cassé
          une référence, on sort sans rien avoir écrit.
        """
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
            # Hors transaction, seul endroit où ce PRAGMA a un effet. Sans lui,
            # le DROP serait refusé par les tables qui référencent celle-ci.
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
                # SQLite refuse une contrainte CHECK dans un ALTER TABLE ADD
                # COLUMN : sur une base existante la colonne arrive donc sans
                # elle. Les écritures passent toutes par `register_profile` et
                # par cette migration, qui n'écrivent que les deux valeurs
                # admises — et une base neuve, elle, porte bien le CHECK.
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
            # Après les ALTER, pour que la table reconstruite emporte aussi les
            # colonnes qui viennent d'être ajoutées.
            self._widen_state_checks(connection)
            # `DROP TABLE` a emporté les index de la table reconstruite. Rejouer
            # le schéma les recrée — les `CREATE TABLE IF NOT EXISTS` qui
            # précèdent sont alors sans effet.
            connection.executescript(SCHEMA)
            # Profil réservé de l'exécutant Agent Core.
            #
            # C'est une ligne de `profiles` comme les autres, et c'est tout
            # l'intérêt : le routage, la santé, les bails et les tentatives
            # continuent de fonctionner sans connaître Agent Core. Elle n'est pas
            # pilotée par la configuration des agents ACP — `sync_profiles` la
            # laisse donc tranquille.
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
