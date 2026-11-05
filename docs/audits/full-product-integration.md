# Full product integration — work in progress

Starting commit: `03ca98e14640830ebb566e5a12cf91e622f34503` (master).
Branch: `feat/full-product-integration`.

This is an initial differential audit, not a release certification. No browser E2E scenario has been executed for this work yet. Existing green CI results do not certify the newly requested product journeys.

## Initial traceability matrix

| Feature                 | Backend                                                                                                                     | API                                                      | Frontend                                                   | Real tests this iteration             | State                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- | -------------------- |
| Transactional additions | Event, inbox, outbox and lease implementations use Maps; no production references found                                     | Existing Mission Engine routes must remain authoritative | Existing mission-engine, tasks, runs and DAG sections      | Not executed                          | in_memory_only       |
| Providers               | Existing account service and ACP orchestrator; added drivers need runtime tracing                                           | Existing provider routes                                 | Existing providers section                                 | No authenticated provider exercised   | partially_integrated |
| Sessions                | Added NativeSessionManager has no production caller found                                                                   | Existing sessions need separate audit                    | Chat and worktree integration need tracing                 | Not executed                          | partially_integrated |
| Handoffs                | Context-transfer utility; existing worktree handoff API                                                                     | Dashboard client has handoffWorktree                     | Full chat continuity not verified                          | Not executed                          | partially_integrated |
| Usage and quotas        | UsageTracker is disconnected; existing BillingUsageRecord and tenant billing service must be assessed before adding storage | Usage endpoints return explicit 503                      | Existing quota-forecast section; full Usage screen missing | Not executed                          | partially_integrated |
| MCP server              | Added NexusMcpServer has static mission/device/usage responses and in-memory tokens; no production caller found             | Operational transport not verified                       | Existing MCP section targets the client manager            | No real external MCP client exercised | mocked               |
| Multi-tenant            | Existing TenantPlatformService plus disconnected TenantSecurityService; overlapping role vocabularies                       | Existing tenant platform needs adversarial audit         | Complete workspace journeys not verified                   | Not executed                          | partially_integrated |
| Observability           | Existing observability, advanced-observability and telemetry services                                                       | Existing dashboard diagnostics                           | Existing logs, quota forecast and run-comparison sections  | No injected incident exercised        | partially_integrated |

## Architecture and integration decisions

- The Python Mission Engine already has SQLite and PostgreSQL database adapters (`services/mission-engine/src/nexus_engine/database.py`, `postgres_database.py`) and a mission repository. Its ownership must be preserved.
- `services/api/src/services/container.ts` supports injected stores and defaults to several memory stores. Production bootstrap injection must be traced before concluding that production uses these defaults.
- The API already has `agent-run-claims.ts`, persistence adapters, `tenant-platform.ts`, `provider-accounts.ts`, `acp-orchestrator.ts`, and telemetry services. Do not create competing ownership paths.
- The dashboard already contains providers, MCP, mission-engine, DAG debugger, quota forecast, VCS worktrees and diagnostics sections. Extend these components and shared API client rather than replacing the Spatial OS.
- Organization roles in TenantPlatformService include OWNER, ORG_ADMIN, TEAM_MANAGER, MEMBER, AUDITOR and BILLING_ADMIN. The new tenant security helper uses ADMIN/MEMBER/VIEWER. Resolve authorization semantics using the operational service before exposing new workspace actions.

## First correction: remove MCP false success

The exported MCP facade previously returned invented mission IDs, devices and constant usage. Authorized calls now return a structured `NEXUS_SERVICE_UNAVAILABLE` tool error. Scope checks still execute before the unavailable response. This prevents false successes; it does **not** complete the MCP integration. In-memory tokens remain an unresolved limitation and this facade must not become a production authentication boundary.

Changed files:

- `packages/mcp/src/server.ts`
- `packages/mcp/test/server-apps.test.ts`

Validation executed: MCP package test suite, 9 files / 82 tests passed. These are package tests, not E2E evidence. No screenshot or live provider evidence exists yet.

## Pending implementation and acceptance

1. Trace production store injection and Mission Engine transactions; implement missing durable guarantees in the existing owner, then test restart and competing workers against PostgreSQL.
2. Trace provider events to existing persisted usage/billing data; establish provenance, idempotency and server-derived tenant scopes before exposing usage APIs.
3. Connect MCP tools to operational permission-checked services, with persistent expiring/revocable credentials and existing confirmation handling.
4. Integrate accounts, usage, MCP, missions, handoffs, organizations and diagnostics into the existing UI and shared contracts.
5. Run actual browser scenarios A–H with service dependencies; retain logs and screenshots. Authentication-dependent scenarios remain unverified until executed.

## E2E evidence ledger

| Scenario           | Result  | Evidence                                                 |
| ------------------ | ------- | -------------------------------------------------------- |
| A Providers        | BLOCKED | Not executed; real provider authentication not inspected |
| B Usage            | BLOCKED | Collectors and UI not integrated                         |
| C MCP              | BLOCKED | Operational server integration pending                   |
| D Missions restart | BLOCKED | Fault-injection scenario not run                         |
| E Handoff          | BLOCKED | Cross-provider session scenario not run                  |
| F Organizations    | BLOCKED | Browser/API/WebSocket adversarial scenario not run       |
| G Observability    | BLOCKED | Controlled incident not run                              |
| H Responsive       | BLOCKED | Browser validation not run                               |

## Delivery status

No public deployment, merge or release is authorized by this work. Startup commands, full architecture after integration, screenshots, updated factual T3 comparison and final commit inventory are pending actual implementation and execution. No claim of feature parity is made.

Rollback for the first correction: revert its dedicated commit; no database change is included. Reverting restores the prior static responses and is not a recommended production behavior.

| Module                  | Backend              | Persistence          | API                  | UI                   | E2E     | Final status         |
| ----------------------- | -------------------- | -------------------- | -------------------- | -------------------- | ------- | -------------------- |
| Orchestration additions | in_memory_only       | missing              | partially_integrated | partially_integrated | blocked | partially_integrated |
| Providers               | partially_integrated | partially_integrated | partially_integrated | partially_integrated | blocked | partially_integrated |
| Sessions                | partially_integrated | partially_integrated | partially_integrated | partially_integrated | blocked | partially_integrated |
| Handoffs                | partially_integrated | partially_integrated | partially_integrated | partially_integrated | blocked | partially_integrated |
| Usage & Quotas          | partially_integrated | partially_integrated | blocked              | missing              | blocked | partially_integrated |
| MCP server              | partially_integrated | in_memory_only       | missing              | missing              | blocked | partially_integrated |
| Multi-tenant            | partially_integrated | operational          | partially_integrated | partially_integrated | blocked | partially_integrated |
| Observability           | partially_integrated | partially_integrated | partially_integrated | partially_integrated | blocked | partially_integrated |
