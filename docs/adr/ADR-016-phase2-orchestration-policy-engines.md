# ADR-016 — Retain native orchestration and policy ports for Phase 2

**Status**: Accepted · 2026-10-24

## Context

Phase 2 requires an evidence-based evaluation of Temporal behind the Mission Engine boundary and OPA
behind the execution-policy boundary. Personal deployments must remain provider-free, and an external
engine cannot replace durable confirmation, task fencing, idempotent outbox delivery, or fail-closed tool
authorization without migration and parity evidence.

## Decision

Do not adopt Temporal or OPA in Phase 2 A0. Keep both as optional future adapters behind the existing
Mission Repository and Execution Policy boundaries.

Temporal was evaluated against the executable durable lifecycle suite. It offers replicated workflow
history, but adopting it now would require a second persisted state model and a destructive migration.
There is no demonstrated parity for stable attempt IDs, payload-hash confirmation, stale-lease rejection,
personal offline mode, or the existing mission snapshots. PostgreSQL-backed Mission Repository instances
now provide the required node failover without a mandatory workflow service.

OPA was evaluated against the Agent Core policy and confirmation suites. Moving decisions out of process
would add a network failure mode and a second policy language without demonstrated parity for typed tool
risks, confirmation payload hashes, per-run budgets, or offline operation. The native policy remains
fail-closed; an unavailable future adapter must deny rather than fall back to allow.

## Executable parity gates

- `test_postgres_ha.py` kills a process holding a mission lease, recovers the same attempt elsewhere,
  rejects the stale token, and proves one committed effect.
- `test_durable_lifecycle.py` covers restart, fencing, confirmation, outbox deduplication, retries, and
  stable idempotency.
- Agent Core loop and policy tests cover budget exhaustion, risky-action confirmation, refusal, expiry,
  cancellation, and immutable payload authorization.

Any future Temporal or OPA adapter must pass those suites unchanged, add migration rollback evidence, and
remain optional. Until then, configuration that requests either adapter must fail closed as unsupported.
