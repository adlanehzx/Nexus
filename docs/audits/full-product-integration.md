# Full product integration — work in progress

Starting commit: `03ca98e14640830ebb566e5a12cf91e622f34503` (master).
Branch: `feat/full-product-integration`.

This report is not a release certification. The current status is the section "Status on 2026-11-05" at the end; the earlier sections are kept as the history of each iteration, and the "E2E evidence ledger" and matrices above it are superseded.

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

## Iteration 2 — observed personal usage

Production bootstrap (`services/api/src/server.ts`) injects PrismaAgentRunStore. Agent Core's execution loop accumulates actual response input/output token usage in the run record. The `/api/v1/usage` endpoint now projects these existing records for the authenticated user, within a validated 1–366 day window (default 30). It rejects client-supplied organization scopes and returns no transcript, response text, secret or reasoning content. Existing snapshot upserts avoid double-counting a run each time it is saved.

The existing quota forecast screen now also displays observed runs, model, date and input/output/cache counters through DashboardApi. Missing cache metrics remain null and display Unavailable. Billed costs and subscription quotas remain unavailable; no inference from a model name is used to invent provider/account attribution. This is a personal Agent Core usage slice, not complete external CLI telemetry or organization billing.

Validation: 7 usage API/package tests passed, including anonymous access and forged tenant query rejection; API wiring check passed. API and dashboard TypeScript checks passed. Browser E2E and PostgreSQL restart validation for this new endpoint have not been performed. The API tests use the existing test harness and are not proof of production persistence.

Remaining work for this slice: database-side scoped projection/pagination (current implementation follows the existing dashboard's listAll then owner-filter pattern), aggregate graphs, explicit primary navigation, collector/account attribution, exports, period controls, durable integration test and browser evidence. Usage & Quotas remains partially_integrated.

## Iteration 3 — scoped usage queries and PostgreSQL evidence

Usage reads now filter user and period inside Prisma, with a bounded page size and deterministic ordering. The existing quota screen supports periods and previous/next pages. The response retains its existing shape and adds nullable `nextOffset`.

Executed: 27 persistence tests against disposable PostgreSQL; authenticated Fastify usage test backed by real Prisma, including two-account isolation and exclusion of private response text; 7 usage tests; API/dashboard type checks and targeted lint. These tests do not exercise a browser or an actual provider. A new service instance reads the persisted run; this is not a crash/restart mission test.

## Mobile coordination — satellite authorization

Reviewed `apps/mobile/docs/BACKEND-GAPS.md` from the separate mobile checkout. No mobile files were modified. `/usage` retains the coordinated shape with additive `nextOffset`.

Confirmed unauthorised satellite listing and command submission in the prior API. Added trusted provisioning configuration `SATELLITE_OWNERS_JSON` mapping satellite IDs to owner user UUIDs, alongside existing token hash provisioning. List responses are owner-filtered; command submission to another owner's or unassigned satellite returns 404 before queue mutation. Existing installations must assign owners before user control is restored. This is an immediate access-control fix, not the final provisioning UI or durable command queue.

Validation: all 4 satellite route tests passed, including cross-account infrared command denial, unassigned-device denial and owner-only visibility. API TypeScript and targeted lint passed. Streaming, `agent.started`, push delivery, satellite result ownership and client-core Metro entrypoint remain pending. No mobile branch was merged.

## Iteration 4 — runtime and mobile contracts

- `agent.started { runId, conversationId }` now reaches the existing owner-scoped EventRouter when a previously absent run is first saved as running. Emission happens after persistence; subsequent saves do not re-emit it. The existing protocol/client-channel mapping is reused. Agent Core HTTP suite: 20 tests passed. Actual mobile socket delivery and stop-during-generation have not been exercised.
- `GET /api/v1/satellites/:deviceId/commands/:correlationId` returns `{ data: { state, result } }` for the configured owner, with queued/delivered/completed state. Unknown or foreign resources return 404. Results are keyed by device and correlation ID, accepted only after delivery, and cannot overwrite another device's result. Repeated command IDs reuse the existing command within this process. Satellite suite: 4 tests passed. Queues/results are still in memory, so restart durability remains unfinished.
- Added `@nexus/client-core/mobile` entrypoint excluding the Node-only encrypted peer transport while preserving existing root exports. Build and all 209 client-core tests passed. The mobile branch must opt into this entrypoint; Metro build compatibility has not been validated here.
- API type checking, targeted lint and API wiring passed. `/usage` is unchanged. Token streaming and push notifications remain unfinished.

New contract details for mobile coordination: the satellite result endpoint uses the exact requested envelope, and the new optional package subpath is `@nexus/client-core/mobile`. No mobile files were changed and no branch was merged.

## Status on 2026-11-05

Statuses describe what was run. Scenario data for Usage is a labelled database fixture, because no model provider was available to E2E: it proves database → API → screen, not that a provider reported the counters.

### Browser scenarios

Run with Playwright against a real API, dashboard and Mission Engine on disposable PostgreSQL and Redis (`apps/dashboard/e2e`).

| Scenario           | Result  | What was observed                                                                                                                     |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A Providers        | PASS    | Screen matches the server's real host detection. No authenticated provider session was created.                                       |
| B Usage            | PASS    | Own runs only, unknown cost shown as unavailable, CSV export. Fixture data.                                                           |
| C MCP              | PASS    | Token created in the UI drives real tools, scope denial recorded, revocation cuts access. Official SDK client covered in API tests.   |
| D Missions restart | PASS    | SIGKILL of the engine: shown as unreachable; queued mission and schedule intact and not resubmitted. No running agent or two workers. |
| E Handoff          | BLOCKED | Not run: needs authenticated providers. No handoff UI was built.                                                                      |
| F Organizations    | PASS    | Interface and API isolation, role escalation refused, audit events written. WebSocket isolation not part of this scenario.            |
| G Observability    | PASS    | Controlled 404 found from its correlation id; plain account refused.                                                                  |
| H Responsive       | PASS    | Three screens at 390, 820, 1280 and 1920 px. Only those screens.                                                                      |

All ten browser tests passed together on `e09811d`. Only the logout fix `6f1a327` came after, and it was covered by the API suites: 515 unit tests and 37 PostgreSQL tests passing. GitHub CI passed all 10 jobs on `6fca0b1` (PR #23), including the monorepo build, lint, typecheck and tests, and PostgreSQL. CI does not run the browser suite, which stays a local step.

### Matrix

| Module         | Backend              | Persistence          | API                  | UI                   | E2E     | Final status         |
| -------------- | -------------------- | -------------------- | -------------------- | -------------------- | ------- | -------------------- |
| Orchestration  | partially_integrated | partially_integrated | operational          | partially_integrated | PASS    | partially_integrated |
| Providers      | partially_integrated | partially_integrated | operational          | partially_integrated | PASS    | partially_integrated |
| Sessions       | partially_integrated | missing              | partially_integrated | missing              | BLOCKED | partially_integrated |
| Handoffs       | partially_integrated | missing              | partially_integrated | missing              | BLOCKED | partially_integrated |
| Usage & Quotas | partially_integrated | operational          | operational          | operational          | PASS    | partially_integrated |
| MCP            | operational          | operational          | operational          | partially_integrated | PASS    | partially_integrated |
| Multi-tenant   | partially_integrated | operational          | partially_integrated | partially_integrated | PASS    | partially_integrated |
| Observability  | partially_integrated | partially_integrated | operational          | operational          | PASS    | partially_integrated |

### Known gaps

- Orchestration: `InMemory*` transactional classes in agent-core are still unused by production. Durability relies on the Mission Engine's own store. Competing workers and a crash during a running agent were not exercised in E2E.
- Providers: `claude auth status` and `codex login status` give the real sign-in state, locally and without quota, and one real conversation passed through the ACP runner with Claude Code, on 2026-11-05, in an empty workspace, with the account owner's approval (`services/agent/test/real-agent.smoke.test.ts`, adapter `claude-agent-acp@0.63.0`). It proves that runner path only: no chat, mission or worker was involved, and Codex was not exercised. `ProviderHub` sessions remain a facade; the working path is the ACP runner in `services/agent`. Antigravity has no observed status command and stays unknown. A lapsed session has not been observed, so none is ever reported. On hosts with mise wrappers, set `NEXUS_PROBE_ENV_ALLOWLIST=__MISE_DIFF`, otherwise the wrapper re-launches itself until the probe times out.
- Usage: no provider, account, quota or billed-cost collectors, and no multi-account filter or comparator. Provider quota fields stay unavailable until something reports them.
- MCP: no catalogue or install flow, no interactive tool tester, no resources and prompts view. `nexus_trigger_mission` has no extra human confirmation beyond the scope and the engine's own permissions.
- Multi-tenant: workspaces, projects and environments have no UI. Provider credentials and jobs were not audited for tenant boundaries.
- Sessions and handoffs: `NativeSessionManager` has no production caller. The chat has no provider selector; its former buttons changed nothing and were removed.
- Confirmations remain in memory, so pending ones are lost on restart. Satellite command queues too.
- Streaming: text a model writes before a tool call is streamed but not persisted, so it disappears when history reloads.
- Push: tested against a fake provider only. No message went through Expo.
- Voice routes (mobile gap 10) were not built.

### Commands

```
scripts/e2e-stack.sh up
pnpm --filter @nexus/dashboard exec playwright test
scripts/e2e-stack.sh down
```

### Rollback

Nothing is merged or deployed. Before merging, drop the branch. After merging, revert its commits; migrations `20261105140000_mcp_access` and `20261105160000_push_tokens` only add tables, which can be dropped once unused. Satellites need `SATELLITE_OWNERS_JSON`, or user control stays refused.
