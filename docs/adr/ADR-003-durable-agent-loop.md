# ADR-003 — Durable Agent Loop Executed in a Separated Worker

**Status**: Proposed · 2026-09-01 · **Core Architectural Decision**

## Context

Three requirements are incompatible with a traditional in-memory agent loop held inside the HTTP
process:

1. **Human Confirmation** — A run may wait several minutes for a user response.
2. **Cancellation** — Can be triggered from a device other than the one that started the run.
3. **Resilience** — A redeployment or crash must not lose an active run, especially after it has
   already dispatched an email or modified a file.

## Decision

1. The loop is a **reducer over persisted state**: `AgentRun` holds the state, and `AgentStep` logs
   each transition (`UNIQUE(runId, index)`).
2. It executes inside `apps/worker` (BullMQ), separated from `apps/api`.
3. A confirmation **suspends** the run (`WAITING_CONFIRMATION`) and **frees** the worker; the user's
   reply enqueues a resume job that reloads state.
4. A Redis lock per run guarantees that only one worker advances it at any given time.
5. The state transition function is pure and injected with ports (`llm`, `store`, `executor`,
   `clock`): testable without database or network, and fully **replayable**.

## Alternatives

- **In-memory loop in API.** Simple, but: a deployment kills active runs, a confirmation blocks an
  HTTP connection, cross-device cancellation requires an ad-hoc channel, and nothing is replayable.
  Rejected.
- **Durable workflow engine (Temporal, Inngest, Restate).** Technically the best answer to the
  problem — but Temporal adds an operational cluster on a VPS, and Inngest/Restate introduce SaaS
  dependencies or extra services. Our durable needs are satisfied by "persisting steps and resuming":
  BullMQ + PostgreSQL covers this well. **Migration path preserved**: because the loop is already an
  explicit state machine, porting it to an external workflow engine would be an executor rewrite,
  not a logic redesign.
- **Sub-process per run.** True memory isolation, but disproportionate startup overhead and
  supervisory complexity.

## Consequences

**Positive** — Runs survive redeployments and crashes; the "Run Inspector" and evaluation suites
come for free from persisted steps; the API maintains a clean p99; workers and API scale
independently.

**Negative, accepted** — More code than a naive implementation; each transition writes to the
database (measured overhead: a few writes per iteration, negligible); requires explicit handling of
distributed locks, resume idempotency, and orphaned runs (alert on `RUNNING > 10 min`).
