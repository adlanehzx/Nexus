# 23 — NEXUS Mission Engine

## Architectural Decision

NEXUS maintains its own persistent local execution engine. ACP agent runtimes, SQLite task leases,
and paper-only financial simulation ledgers live within the NEXUS repository.

```text
Web / Mobile / Desktop Client
          │ NEXUS JWT
          ▼
      NEXUS API ── Typed Contract ──▶ NEXUS Mission Engine :18100
          │                                  │
          │                                  ├─ Antigravity ACP
          │                                  ├─ Claude ACP
          │                                  ├─ Codex ACP
          │                                  └─ Paper-only Ledger
          ▼
NEXUS Chat Interface + Administrative Supervision
```

This separation avoids conflicting authorities:

- NEXUS API authenticates users and manages public interfaces;
- NEXUS Mission Engine manages persistent state for ACP missions and task DAGs;
- Client applications never connect directly to internal engine port 18100;
- `@nexus/mission-control-client` validates every response against typed contracts.

## Configuration

`MISSION_CONTROL_URL=http://127.0.0.1:18100` enables the mission engine integration when running on the
same host. An empty string disables it. Plain HTTP is rejected outside local loopback addresses; remote
deployments require HTTPS.

Engine status renders in the dashboard under "Mission Engine". Paper-only simulation routes live under
`/api/v1/mission-control/*` and require administrator credentials.

Runtime settings applied to newly created missions reside in `services/mission-engine/config/runtime-settings.json`.
The "Configuration" tab supports live updates to timeouts, retry policies, backoff intervals, context
token budgets, quality review thresholds, and priority hierarchies. Writes are validated, atomic, and
backed up to `.bak-<UTC>`.

The bridge to Agent Core requires `NEXUS_ENGINE_API_URL` (the base URL of the NEXUS API). When unconfigured,
the Agent Core executor is disabled and delegated tasks fail with error category `config` — avoiding
silent fallback to ACP agents. The gateway rejects non-loopback HTTP URLs, ensuring bearer tokens traverse
only secure interfaces.

## Unified Conversational Interface

The dashboard provides a single unified chat interface. Messages submitted to NEXUS follow this path:

```text
User Message
  → Pluggable LLM Planner (Emits validated DAG or deterministic fallback plan)
  → POST /v1/missions dispatched to NEXUS Mission Engine
  → ACP agents execute in parallel according to DAG dependency graphs
  → Upstream results injected into downstream task instructions
  → Structured quality control for multi-task missions
  → Corrective refinement by an alternative agent profile if needed (Max 2 revision loops)
  → Final synthesis task (nexus_final_synthesis)
  → Single unified response delivered in chat
```

`POST /api/v1/orchestrator/messages` requires an authenticated NEXUS session. Clients never access port
18100 directly. Each mission's external identifier embeds a cryptographic hash of the owner user ID;
lookups are rejected if accessed by an unauthorized user even with knowledge of the UUID. Active mission
UUIDs are tracked in UI route params to support page reloads without storing sensitive session tokens
or data in browser storage.

The planner selects among agent profiles advertised as healthy. In case of invalid model outputs or
unavailability, a deterministic plan takes over. The Mission Engine owns task persistence, leases,
execution timeouts, and retries.

Temporal scheduling prompts ("Every weekday morning, analyze market trends") produce durable schedules.
The structured planner distinguishes `immediate`, `one_shot`, and `cron`; ambiguous inputs default to
`immediate` rather than guessing recurrence. The browser's IANA timezone accompanies the request, and
the Mission Engine calculates schedule offsets, catch-up executions, and run history.

For recurring schedules containing `agent-core` tasks, the API creates an opaque **calendar delegation grant**.
PostgreSQL records only its hash; the engine receives the token once and excludes it from mission JSON
and response envelopes. Upon trigger, the engine presents this delegation alongside the occurrence UUID
and timestamp. The API validates the account and issues a short-lived mission grant. Recurring schedules
cannot cross user boundaries or expand permissions.

Each task maintains an ordered list of fallback profiles. ACP errors are classified locally by the
NEXUS runtime (`auth`, `quota`, `rate_limit`, etc.) without echoing verbose vendor outputs. Staged
tasks switch to the highest-priority available fallback profile upon error. Upstream results are
compacted according to task context budgets prior to prompt injection.

Profile registries record 5-hour and weekly usage percentiles and reset times when provided by official
CLI interfaces. When subscriptions omit quota endpoints, values remain `null`: NEXUS relies on structured
error codes, cooldowns, and observed failures without guessing quotas.

For multi-task missions, NEXUS attaches a quality reviewer task returning strict JSON verdicts.
A `revise` verdict atomically augments the persisted DAG with a corrective task (assigned to an
alternative profile) followed by re-review. The final synthesis task pauses until quality review passes.
Refinements are bounded to at most two iterations.

## Agent Registry Management

The administrative "Agents" dashboard lists profiles registered in the Mission Engine: online status,
active tasks, queue backlog, and observed state. It discovers adapters declared in the native ACP registry.

Enrollment never exposes ACP credentials to the browser. The administrator selects an existing ACP
profile and maps it to a NEXUS profile key. The engine verifies the profile, saves a backup to
`profiles.production.json.bak-<UTC>`, atomically writes configuration, and hot-syncs its SQLite registry.
Active running missions are not interrupted.

The dashboard can also clone existing verified adapters (Antigravity, Claude, Codex) with custom names
or model identifiers. New providers require installing their local ACP adapter before importing.

Profiles can be configured to tune names, models, execution commands, arguments, system prompts,
reasoning effort levels, ACP options, and allowed workspace directories, followed by running live ACP test probes.
Disabling an agent excludes it from future missions without interrupting active runs. Permissions
remain sandboxed to the mission workspace. Sessions and provider credentials remain inside local CLI
runtimes; zero provider tokens are stored or displayed by the dashboard.

## Administrative Supervision from Dashboard

Supervision and management actions flow through verified API routes with full server authorization checks:

- Approval, scoping, and revocation of worker devices;
- Cooperative cancellation of active running tasks;
- Memory creation, inspection, and deletion;
- Notification history inspection;
- Paper simulation market and ledger administration;
- Configuration, test execution, and disabling of ACP agent profiles;
- Runtime orchestrator settings;
- Local secret vault management, dynamic MCP server attachment, and Browser Use configuration.

Audit views — agent runs, security events, and system logs — serve read-only inspection. Destructive
actions require explicit confirmation dialogs. MCP attaches to the API `ToolRegistry` with live hot-reloading.
Browser Use connects to local browser daemons only when enabled and when tokens are present in the host
keyring. Configuration files store `vault://nexus/...` references, never raw secrets.

### Unified Task Inspection and State Persistence

The Mission Engine provides a filterable projection of durable missions: DAG state, dependencies, and
ACP attempt records, omitting private reasoning traces. The API scopes this view by user ID before
rendering across three administrative interfaces:

- `Tasks` presents missions as plans and ACP tasks as steps;
- `Agent Runs` displays ACP attempts, assigned profiles, durations, and errors;
- `Tools` surfaces active ACP profiles as `acp.<profile>` tools alongside native and browser capabilities.

SQLite remains the single source of truth for mission orchestration; PostgreSQL does not duplicate this state.

User preferences and long-term memory items are assembled before planning and injected into task prompts
within explicit untrusted data fences, ensuring retrieved facts cannot overwrite system instructions.

Conversations, chat messages, notifications, and Agent Core runs are persisted in PostgreSQL. Agent Core
runs execute via `/api/v1/agent-core/runs`, and confirmation resumptions share the same permission policies
as native tools. Observability logs are maintained in `var/observability` as redacted JSONL files with
`0600` permissions.

## Bridge: Mission Engine → Agent Core

A task within a mission DAG can delegate execution to Agent Core rather than spawning an ACP agent,
declared via `agent_kind: "agent-core"`.

### API → Engine Request Authentication

Internal port 18100 was previously defended strictly by loopback isolation. While sufficient for
single-user local machines, loopback isolation is insufficient across container networks or multi-node clusters.

The API signs outbound requests with a short-lived **service token** — audience `nexus-mission-engine`,
2-minute lifespan. The engine **holds only the public verification key**: it validates tokens, but
cannot issue them. Compromising the engine does not grant the ability to forge API credentials.

**Middleware Enforcement**: Mutating HTTP verbs (`POST`, `PUT`, `DELETE`, `PATCH`) require token
validation across all routes. Read-only requests (`GET`, `HEAD`, `OPTIONS`) remain unauthenticated over
loopback for monitoring probes.

Configuring `NEXUS_ENGINE_API_PUBLIC_KEY_FILE` (or `NEXUS_ENGINE_API_PUBLIC_KEY`) enables token verification.
When absent, the engine logs an explicit warning indicating unauthenticated local mode.

### Cryptographic Owner Assertions

Mission ownership previously relied on prefix conventions inside `external_key`.
The API now issues a signed **Ed25519 owner assertion** `{sub, svc, mek, iat, exp, iss, aud, jti}` —
recording owner ID, authorized service, and mission key. It persists on the mission record and is
presented on delegated bridge invocations.

Architectural guarantees:

1. **The Engine Cannot Sign Assertions**: SQLite compromises cannot forge valid assertions.
2. **Audience Separation**: User access tokens carry audience `nexus-api`; mission assertions carry
   `nexus-mission-grant`. They cannot be substituted for one another.
3. **Scope Enforced**: `assertMissionScope` validates that the assertion matches the specific mission
   external key, preventing tokens from accessing other missions.

Assertions are excluded when computing `content_hash`: idempotent plan resubmissions remain stable.

### Assertion Lifecycle and Rotation

Assertions feature a 24-hour validity window.

**Registry Verification**: The `mission_grants` table tracks active assertions, validated by `requireMissionGrant`.
Stolen assertions can be revoked before expiration. Assertions absent from the registry are rejected by default.

**Automated Rotation**: Missions paused waiting for human confirmations may outlive their initial assertion.
The API automatically issues a renewed assertion in response envelopes when remaining validity drops
below 8 hours. The prior assertion remains valid until natural expiration to avoid race conditions with
in-flight requests.

**Revocation**: When a mission reaches a terminal state (`succeeded`, `failed`, `cancelled`), the worker
requests grant revocation.

**Idempotent Resubmission Refreshes Grants**: Resubmitting a mission updates `owner_assertion` to
prevent long missions from stalling on expired tokens. Owner user IDs are immutable.

### Bridge API Endpoint

`POST /api/v1/agent-core/mission-runs`, protected by `requireMissionGrant` — distinct from `/agent-core/runs`
reserved for direct user interactions. The caller cannot forge user IDs or target arbitrary missions.

Conversations are instantiated on the first attempt and remembered on the task record (`tasks.agent_core_conversation_id`):
subsequent retries append to the existing conversation rather than fragmenting state.

### Reserved Executor Registration

Agent Core registers as a system profile (`profile_key='agent-core'`, `agent_kind='agent-core'`).
Scheduling, leases, and retry logic operate uniformly without coupling to Agent Core internals.
This profile is omitted from public ACP agent lists (`/v1/profiles`) and cannot be disabled via UI.

Agent Core tasks **cannot declare ACP fallbacks**: switching to an ACP agent would forfeit permissions,
confirmation gates, and specialized tools.

### Exactly-Once Run Claim per Task Attempt

Agent Core runs can exceed the duration of standard 30-second worker leases. If a lease expires mid-step,
a secondary worker must not execute duplicate mutating tools.

The bridge transmits `attemptId`, and the API records `(missionExternalKey, taskKey, attemptId)`
inside `agent_core_run_claims` under a unique constraint. Duplicate requests for the same attempt return
the existing run record without re-invoking the model.

- **Enforced via Database Unique Constraints**: Prevents race conditions between concurrent worker threads.
- **Granularity is the Attempt**: Retrying a failed step assigns a new attempt ID, granting a fresh run.
- **Run ID Generated Prior to Claim**: Prevents orphaned claims lacking run records.

### Durable Suspension on Confirmation Prompts

When a delegated Agent Core run requests human confirmation, the mission task enters `awaiting_confirmation`,
preserves its run identifier (`tasks.agent_core_run_id`), and releases its worker lease. The paused state
persists in SQLite, surviving engine restarts.

**Polling Model**: The engine polls the API for confirmation status updates rather than exposing an
inbound webhook callback, avoiding unnecessary attack surface on internal ports.

- **Polling Does Not Consume Retry Attempts**: `claim_confirmation_poll` reuses the active attempt record.
- **Rejections Are Not Retried**: User rejections fail the task cleanly rather than looping.
- **Due Confirmations Take Priority**: Active confirmation runs are processed before enqueuing new work.

Operators approve or reject confirmations through the standard dashboard route:
`POST /api/v1/agent-core/runs/:runId/confirmation`.

### End-to-End Verification Scenarios

Automated integration test suites validate the end-to-end architecture against real processes:

`services/api/scripts/e2e-confirmation.mjs` executes the full human-in-the-loop lifecycle across two real processes:

```
Mission → Agent Core Task → Risk Tool → awaiting_confirmation
→ Engine Restart (SIGTERM + Reboot) → User Approval via Dashboard API
→ Resumption → Task Succeeded → Mission Succeeded
```

`services/api/scripts/e2e-mission-chain.mjs` validates standard collaborative missions:

```
Chat Message → Validated DAG Plan → Parallel ACP Agents
→ Dependent Task Receiving Prior Outputs → Profile Failure Simulation
→ Dynamic Fallback to Backup Agent → Engine Restart Mid-Flight
→ Successful Recovery → Quality Control Review → Final Synthesis
→ Verified Response Delivered to User
```

Both scenarios run against live Fastify APIs, PostgreSQL, SQLite, and Python processes with real HTTP
and token verification in CI.

## Security and Trust Boundaries

Mission Engine is treated as an internal service: requests enforce independent timeouts, Zod validation
across all responses, and sanitized error envelopes. Real financial trading or raw private key exports
are strictly prohibited.

The engine binds strictly to `127.0.0.1`. Deployments across containers or nodes require private authenticated
networks or secure reverse proxies with mTLS.
