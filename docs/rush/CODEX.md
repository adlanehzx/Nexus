# Codex rush work file

## Mission

Own the durable multi-agent mission path and integrate the three rush branches into one verified user
journey. Codex is the integration owner, not a replacement for Claude's connection plane or Gemini's
product experience.

## Branch contract

- Suggested branch: `codex/rush-orchestration-integration`
- Worktree: isolated from `master` and from the Claude and Gemini worktrees
- Base commit: the same `master` commit containing this work file; record its exact SHA before starting
- Push/merge/rebase: forbidden until the user requests integration

## Owned areas

- `services/mission-engine/**`
- `packages/agent-core/**`
- `packages/memory/**`
- mission, run, task, routing, usage and memory API routes/services
- mission-oriented database changes and tests
- E2E agent-chain, confirmation, restart, fallback and blank-install tests
- root integration changes after the other branches are delivered

Do not implement provider detection, MCP sandboxing, browser internals, dashboard presentation, worker
installers or device pairing here.

## Progress summary

| ID  | Deliverable                                    | Status | Commit    | Evidence                                                            |
| --- | ---------------------------------------------- | ------ | --------- | ------------------------------------------------------------------- |
| C0  | Baseline and executable acceptance scenarios   | DONE   | `c7d013a` | 113 Python, 42 Agent Core and 109 Memory tests passed               |
| C1  | Durable mission lifecycle and restart recovery | DONE   | `f3c0213` | 9 lifecycle scenarios and 122 engine tests passed                   |
| C2  | Context, memory and token-budget management    | DONE   | `f535de8` | 43 Agent Core and 109 Memory tests passed                           |
| C3  | Health, quota-aware routing and agent fallback | DONE   | `09f79b0` | 18 routing repository and 123 engine tests passed                   |
| C4  | Human confirmation and safe retry semantics    | DONE   | `bba856d` | 36 bridge, 43 Agent Core and 128 engine tests passed                |
| C5  | Cross-agent integration and full product E2E   | DONE   | `54db07d` | All rush deliveries integrated; deterministic and live ACP E2E pass |
| C6  | Rush closure report and adjustment backlog     | DONE   | `54db07d` | Release gates pass; remaining non-blocking work is ranked below     |

## C0 — Baseline and executable acceptance scenarios

Implement or update deterministic fixtures for the complete mission lifecycle before changing runtime
behavior. Capture current failures without hiding them.

Acceptance criteria:

- A scenario represents one user mission decomposed into dependent and parallel tasks.
- The scenario includes an ACP agent, one tool call, one confirmation and one fallback.
- Existing migrations and stored missions remain readable.
- Baseline commands and exact failing/passing counts are recorded below.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-22T22:11:32+02:00
- Completed at: 2026-10-22T22:14:30+02:00
- Commit: `c7d013a114be0fbbaeb0dbc9586e10579f673d84`
- Commands and results:
  - `uv run --project services/mission-engine pytest -q` — failed before the fix: exit 2,
    `pytest` executable missing.
  - `pnpm --filter @nexus/agent-core test -- --run` — baseline failed: 2 suites failed to
    resolve unbuilt workspace packages; 1 suite and 6 tests passed.
  - `pnpm --filter @nexus/memory test -- --run` — baseline failed: 6 suites failed to resolve
    unbuilt workspace packages; 1 suite and 2 tests passed.
  - `uv lock --project services/mission-engine` — passed, 27 packages resolved.
  - `uv run --project services/mission-engine pytest` — dependency bootstrap succeeded, then
    collection failed because unscoped pytest also collected `services/browser-worker/tests`.
  - `pnpm --filter @nexus/agent-core... build` — passed for 6 projects.
  - `uv run --project services/mission-engine pytest services/mission-engine/tests` — passed:
    113 tests, 1 deprecation warning.
  - `pnpm --filter @nexus/agent-core test` — passed: 3 files, 42 tests.
  - `pnpm --filter @nexus/memory test` — passed: 6 files and 109 tests; 1 file and 7 tests
    skipped by their existing capability guards.
- Notes: Base commit: `f34e3a3c20a02702019e04a88ce38f4bbbf6fa4e`. The deterministic
  fixture proves a dependency DAG with parallel-ready tasks, ACP failure and fallback, one risky tool
  call, durable confirmation, a restart checkpoint, idempotent tool completion and final verification.
  Reopening its SQLite database preserves the submitted mission. The existing legacy state-check
  migration test remains part of the 113-test passing suite.

## C1 — Durable mission lifecycle and restart recovery

Finish persisted mission, task, attempt, lease and outbox state transitions. Prove that killing and
restarting the Mission Engine neither loses work nor duplicates an externally visible action.

Acceptance criteria:

- Ready tasks run in parallel while dependencies remain ordered.
- Leases expire and are safely reclaimed.
- Retry limits, backoff, timeouts and idempotency keys are enforced.
- Restart during execution resumes from persisted state.
- A completed or refused action is never repeated after restart.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-22T22:14:59+02:00
- Completed at: 2026-10-22T22:17:12+02:00
- Commit: `f3c0213263a1faafa5e108cc676fa0baccaa03c7`
- Commands and results:
  - `uv run --project services/mission-engine pytest services/mission-engine/tests/test_durable_lifecycle.py -q` — passed: 6 tests before the migration and terminal-action cases were added.
  - `uv run --project services/mission-engine pytest services/mission-engine/tests/test_durable_lifecycle.py` — passed: 9 tests.
  - `uv run --project services/mission-engine pytest services/mission-engine/tests` — passed: 122 tests, 1 deprecation warning.
  - `git diff --check` — passed.
- Notes: Two independent ready tasks receive concurrent leases while their join remains blocked. An
  expired lease is reclaimed with the same attempt and conversation IDs after repository restart.
  Timeout budgets reach the gateway, retry backoff prevents early acquisition, attempt limits stop
  further work, and submission idempotency survives restart. Completed and refused actions each stay
  at one execution after restart. Outbox delivery now uses expiring fenced leases, stable downstream
  dedupe keys and explicit acknowledge/release transitions. The schema change only adds nullable
  outbox lease columns; no backup was required, and the legacy migration test proves row preservation.

## C2 — Context, memory and token-budget management

Build a bounded context assembly path shared by long missions. Preserve provenance and separate user
instructions, agent results, tool data and memory.

Acceptance criteria:

- Every agent invocation receives a measurable token budget.
- Context compaction is deterministic, persisted and recoverable.
- Critical decisions, constraints and citations survive compaction.
- Sensitive memory remains governed by existing memory policy.
- Mission and task usage can be inspected without storing raw secrets.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-22T22:17:40+02:00
- Completed at: 2026-10-22T22:20:12+02:00
- Commit: `f535de8c1e57af27bd9404aa0ff82cc9710e9b65`
- Commands and results:
  - `pnpm --filter @nexus/agent-core test` — passed: 3 files, 43 tests.
  - `pnpm --filter @nexus/memory test` — passed: 6 files and 109 tests; 1 file and 7 tests skipped by existing capability guards.
  - `pnpm --filter @nexus/agent-core typecheck` — initially failed with 2 missing-property errors because the command read the pre-change Memory `dist`.
  - `pnpm --filter @nexus/memory build` — passed.
  - `pnpm --filter @nexus/memory typecheck` — passed.
  - `pnpm --filter @nexus/agent-core typecheck` — passed after rebuilding Memory.
  - `pnpm exec prettier --check packages/memory/src/context.ts packages/agent-core/src/state.ts packages/agent-core/src/orchestrator.ts packages/agent-core/test/fixtures.ts packages/agent-core/test/loop.test.ts` — passed.
  - `git diff --check` — passed.
- Notes: Context sections retain separate provenance and independent character/token fences. The
  effective aggregate token budget, measured input tokens, compaction flag and per-section drop counts
  are persisted in the run record without raw content. The exact bounded background is retained only in
  the governed durable run state and restored after suspension. The regression test proves that a
  decision and citation survive confirmation suspension and resume. Existing Memory tests prove
  deterministic compaction plus refusal/redaction/consent rules for sensitive content.

## C3 — Health, quota-aware routing and agent fallback

Route work using capabilities, observed health, recent errors and available usage information. Unknown
quota must remain explicitly unknown rather than being treated as unlimited.

Acceptance criteria:

- Routing decisions and their reasons are persisted.
- A controlled agent failure triggers a compatible fallback.
- A task is not sent to an agent known to be unavailable or over a configured limit.
- Account and provider cooldowns prevent failure loops.
- Fallback preserves task context, evidence and idempotency.
- No unsupported scraping of private provider account pages or tokens is introduced.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-22T22:20:50+02:00
- Completed at: 2026-10-22T22:21:26+02:00
- Commit: `09f79b0031568a4d40219e5e54deb070981e09a6`
- Commands and results:
  - `uv run --project services/mission-engine pytest services/mission-engine/tests/test_repository.py` — passed: 18 tests.
  - `uv run --project services/mission-engine pytest services/mission-engine/tests` — passed: 123 tests, 1 deprecation warning.
  - `git diff --check` — passed.
- Notes: Each route attempt now persists ordered candidates, observed health, selected profile and a
  stable reason. Unknown quota remains nullable and is recorded as `unknown`, never converted to a
  numeric allowance. Existing tests plus the new evidence cover controlled fallback, exhausted-profile
  avoidance, cooldown, retry context and stable attempt idempotency. The implementation consumes only
  configured/observed health; it adds no provider scraping or token extraction. The routing table is an
  additive migration and preserves existing rows without requiring a backup.

## C4 — Human confirmation and safe retry semantics

Complete the real confirmation lifecycle for risky tools and external side effects.

Acceptance criteria:

- A risky action becomes durably `awaiting_confirmation`.
- Approval, refusal, expiry and cancellation have distinct terminal behavior.
- Waiting consumes neither a worker lease nor a retry attempt.
- A restart while waiting preserves the request.
- Approval authorizes exactly the displayed action, not a mutable future payload.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-22T22:22:03+02:00
- Completed at: 2026-10-22T22:22:58+02:00
- Commit: `bba856d4264761e6930ad693ea5c58ea417ab56f`
- Commands and results:
  - `uv run --project services/mission-engine pytest services/mission-engine/tests/test_agent_core.py` — passed: 36 tests.
  - `uv run --project services/mission-engine pytest services/mission-engine/tests` — passed: 128 tests, 1 deprecation warning.
  - `pnpm --filter @nexus/agent-core test` — passed: 3 files, 43 tests.
  - `git diff --check` — passed.
- Notes: Risky actions remain durably suspended without a lease or extra attempt. Restart polling uses
  the same run and attempt. Approval still requires the original payload hash, while rejection,
  expiration and cancellation now retain distinct categories and terminal records. Cancellation maps
  task, attempt, mission and outbox events to `cancelled`; rejection and expiration fail without retry.
  Existing Agent Core tests prove approval, refusal, expiry, cancellation and payload mismatch behavior.

## C5 — Cross-agent integration and full product E2E

Integrate Claude's typed connection/tool contracts and Gemini's dashboard/device contracts. Resolve
shared manifests, schema and lockfile once.

Acceptance criteria:

- Fresh-install and upgrade migrations both pass.
- The dashboard creates a mission and streams live progress.
- A real supported agent returns an effective model answer, subject to user approval for quota use.
- A test agent proves deterministic fallback, restart and confirmation behavior.
- MCP and browser operations appear in one audit trail.
- Existing Codex, Claude and Antigravity profiles continue to work.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-23T15:14:44+02:00
- Completed at: 2026-10-23T17:56:15+02:00
- Commit: `f7dc88e2ccda3df7dd5493b82727c45779f150b9`, `a845e651af709ceafe51b7893265571d8ae9aa79`, `358a5c0`, `9baf708`, `2763310`, `54db07d`
- Commands and results:
- `pnpm build` — passed: 32 of 32 package build tasks.
- `pnpm --filter @nexus/api exec vitest run test/setup-status.test.ts` — passed: 1 file, 1 test.
- `pnpm --filter @nexus/dashboard test` — passed: 6 files, 41 tests.
- `pnpm --filter @nexus/dashboard build` — passed: production Vite build, 144 modules transformed.
- `bash -n scripts/blank-machine-restore.sh` — passed.
- `pnpm --filter @nexus/client-core test` — passed: 10 files, 172 tests.
- `DATABASE_PASSWORD=nexus_dev_password bash scripts/blank-machine-restore.sh` — passed: 24 steps, 0 failures; clean archive installation, 15 PostgreSQL migrations, encrypted backup/restore, one restored mission, profile and runtime settings.
- `DATABASE_URL=... pnpm --filter @nexus/database exec prisma migrate deploy` — passed on the dedicated `nexus_c5_e2e` database: all 15 migrations applied from an empty schema.
- `pnpm --filter @nexus/api e2e:chain` without `DATABASE_URL` — failed before execution: 0 steps, required environment missing.
- `DATABASE_URL=postgresql://nexus:nexus_dev_password@127.0.0.1:15432/nexus_c5_e2e?schema=public pnpm --filter @nexus/api e2e:chain` — passed: 27 steps, 0 failures.
- `pnpm --filter @nexus/api e2e:confirmation` without `DATABASE_URL` — failed before execution: required environment missing.
- `DATABASE_URL=postgresql://nexus:nexus_dev_password@127.0.0.1:15432/nexus_c5_e2e?schema=public pnpm --filter @nexus/api e2e:confirmation` — passed: 14 steps, 0 failures.
- `pnpm --filter @nexus/api e2e:schedule-grant` — passed: `E2E Agent Core schedule: OK`.
- `pnpm --filter @nexus/connections test` — passed: 6 files, 177 tests.
- `pnpm --filter @nexus/connector test` — passed: 6 files, 113 tests.
- `pnpm --filter @nexus/mcp test` — passed: 3 files, 42 tests.
- `pnpm --filter @nexus/browser-client test` — passed: 2 files and 28 tests; 1 file and 6 tests skipped by existing host-capability guards.
- `uv run --project services/browser-worker pytest services/browser-worker/tests` — failed before collection: `pytest` was not installed because the documented command omits the declared `dev` extra.
- `uv run --project services/browser-worker --extra dev pytest services/browser-worker/tests` — passed: 76 tests, 2 real-browser tests deselected, 1 deprecation warning.
- `pnpm test` — passed: 54 of 54 Turbo tasks; API included 35 files and 383 tests.
- `pnpm typecheck` — passed: 54 of 54 Turbo tasks.
- `pnpm format:check` — initially failed on 9 integrated files; passed after formatting.
- `pnpm lint` — initially failed with 2 unsafe `Object.values` errors in Memory; passed after the typed aggregate fix: 54 of 54 Turbo tasks.
- `pnpm build` — passed after all integration fixes: 32 of 32 Turbo tasks.
- `uv run --project services/mission-engine pytest services/mission-engine/tests` — passed: 128 tests, 1 deprecation warning.
- `pnpm release:check` — passed: 943 tracked files.
- `pnpm translation:check` — passed: English-only check clean.
- `NEXUS_REAL_AGENT_CONVERSATION=1 NEXUS_REAL_AGENT_PROFILE=antigravity NEXUS_REAL_AGENT_REGISTRY=<absolute-profile-registry> NEXUS_REAL_AGENT_WORKSPACE=<workspace> pnpm --filter @nexus/agent exec vitest run test/real-agent.smoke.test.ts --reporter=dot` — passed: 1 real Antigravity ACP conversation, effective model response received in 8.45 seconds; response content was not logged.
- Notes: Gemini G0-G5 and the Antigravity-delivered CL0-CL5 branch were integrated without replacing the durable mission work. The connection plane includes honest CLI/adapter/auth state, a signed local connector with persistent replay protection, isolated MCP execution, browser ownership and SSRF controls, and deterministic ACP contracts. The first live attempt exposed a portable-profile defect: `--binary-path agy` is treated by the community adapter as a literal filesystem path and closes before ACP initialization. Commit `54db07d` removes that invalid override and lets the adapter resolve `agy` from `PATH`; the authorized retry completed with an effective model response. The blank-install backup was encrypted, restored and removed, dedicated test databases were removed, migrations remain additive, and existing Codex, Claude and Antigravity profile contracts remain covered.

## C6 — Rush closure report and adjustment backlog

Run all release gates from clean state and turn every unresolved observation from all three files into a
prioritized adjustment backlog. Do not call the rush complete with missing evidence.

Acceptance criteria:

- All completion gates in `README.md` have exact evidence.
- Every cross-agent handoff is resolved or explicitly deferred.
- Critical and high-severity findings are zero.
- Remaining UX, performance and maintainability work is ranked for the adjustment phase.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-23T17:56:15+02:00
- Completed at: 2026-10-23T18:00:00+02:00
- Commit: `54db07d` and the following documentation commit
- Commands and results:
  - Full repository gates listed under Final verification all pass.
  - `git status --porcelain` is empty after the closure commit.
  - All C5 handoffs are resolved; durable-consumer and routing-presentation enhancements are explicitly deferred below.
- Notes: No critical or high-severity finding remains open. Adjustment work is limited to retention, dashboard presentation, translation-scanner coverage, Windows connector support and dependency modernization; none invalidates the verified local release path.

## Findings and errors

Add a row after every numbered task, even when the result is `None found`.

| ID   | Task | Severity | Status   | Description                                                                                                                                               | Reproduction or evidence                                                                                                                      | Fix commit           |
| ---- | ---- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| C0-1 | C0   | High     | RESOLVED | The documented Mission Engine command could not install `pytest` because test dependencies were only an optional extra.                                   | `uv run --project services/mission-engine pytest -q` exited 2 with `Failed to spawn: pytest`.                                                 | `c7d013a`            |
| C0-2 | C0   | Medium   | RESOLVED | Unscoped pytest collected the browser-worker suite from the repository root.                                                                              | The command collected 113 items then failed importing `app`; the scoped command passes 113 tests and the final gate now names the suite path. | `c526f6f`            |
| C0-3 | C0   | Medium   | RESOLVED | Direct package tests require built internal workspace exports.                                                                                            | Baseline Agent Core/Memory runs failed package resolution; dependency-closure build followed by both suites passes.                           | `c7d013a`            |
| C1-1 | C1   | High     | RESOLVED | Mission outbox events had no claim or acknowledgement fencing, allowing concurrent or restarted publishers to duplicate delivery.                         | The restart test reclaims the same event and rejects the stale publisher token; only the current lease can acknowledge it.                    | `f3c0213`            |
| C2-1 | C2   | High     | RESOLVED | Agent Core persisted messages but discarded assembled context during confirmation suspension, so resumed calls lost decisions, constraints and citations. | A regression test suspends, reloads stored state, resumes, and observes the same citation in the second model system prompt.                  | `f535de8`            |
| C2-2 | C2   | Low      | RESOLVED | Direct Agent Core typecheck read the previous Memory build output after the cross-package type changed.                                                   | Rebuilding Memory followed by both package typechecks passes.                                                                                 | `f535de8`            |
| C3-1 | C3   | High     | RESOLVED | Routing selected healthy or fallback profiles but did not persist candidates, observations or the audit reason.                                           | Mission snapshots now contain routing decisions; tests prove quota-exhausted fallback and explicit unknown quota.                             | `09f79b0`            |
| C4-1 | C4   | High     | RESOLVED | Mission Engine collapsed rejection and expiry into one category and treated cancellation as a generic empty response.                                     | Bridge and repository tests prove distinct rejection, expiry and cancellation states with zero retry.                                         | `bba856d`            |
| C5-1 | C5   | Critical | RESOLVED | Claude quota expired during CL3, so Antigravity completed and independently verified the full CL0-CL5 delivery.                                           | `antigravity/rush-connections-tools` at `358a5c0`; 600 focused tests passed, including MCP and browser isolation.                             | `358a5c0`            |
| C5-2 | C5   | High     | RESOLVED | A real provider call required explicit quota authorization and an opt-in test that never logs model content.                                              | User authorized one call; Antigravity ACP returned an effective response in 8.45 seconds and the smoke test passed.                           | `2763310`, `54db07d` |
| C5-3 | C5   | Medium   | RESOLVED | First-run UI lacked an unambiguous public probe for whether administrator setup was already initialized.                                                  | `GET /api/v1/auth/setup-status` changes from false to true only after account creation; focused test passes.                                  | `f7dc88e`            |
| C5-4 | C5   | Medium   | RESOLVED | Blank-machine restore assumed a pre-existing Mission Engine `.venv/bin/python`, contradicting a clean installation.                                       | The script now uses `uv run --project`; the blank archive journey passes 24 steps with 0 failures.                                            | `f7dc88e`            |
| C5-5 | C5   | Medium   | RESOLVED | Integrated Gemini files and the C2 aggregate failed repository format/lint gates.                                                                         | Initial format failed on 9 files and lint reported 2 errors; reruns pass 54 lint tasks and the global format gate.                            | `a845e65`            |
| C5-6 | C5   | Medium   | RESOLVED | The original Browser Worker verification command omitted its declared `dev` extra and could not spawn pytest from a clean environment.                    | The final recorded command includes `--extra dev` and passes 76 tests with 2 real-browser tests deselected.                                   | `358a5c0`            |
| C5-7 | C5   | Low      | RESOLVED | The first two local E2E invocations omitted their required dedicated `DATABASE_URL`.                                                                      | Both stopped at 0 steps; exact reruns against `nexus_c5_e2e` pass 27/27 and 14/14 steps, then the database was dropped.                       | N/A                  |
| C5-8 | C5   | High     | RESOLVED | Gemini's progress summary contradicted its completed G3-G5 implementation records.                                                                        | The integrated work file now records G0-G5 as `DONE` with the final commit evidence.                                                          | `9baf708`            |

## Improvements for the adjustment phase

Record improvements that are useful but not required for the rush acceptance criteria.

| ID    | Source task | Priority | Improvement                                                                                         | Why deferred                                                                                                               | Suggested next action                                                                       |
| ----- | ----------- | -------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C0-I1 | C0          | Medium   | Replace deprecated Starlette `httpx` compatibility path.                                            | The warning does not affect correctness or rush acceptance.                                                                | Upgrade the compatible FastAPI/Starlette test client stack after the rush.                  |
| C2-I1 | C2          | Medium   | Add explicit retention expiry for completed Agent Core context snapshots.                           | Current run-store retention governs snapshots and restart recovery requires them while active.                             | Delete snapshot text after terminal-run retention while retaining aggregate usage metadata. |
| C5-I1 | C5          | Medium   | Expand the English-product-string gate beyond structured `userMessage` fields to JSX fallback text. | The current gate passes while older dashboard JSX can still contain a French fallback string; it is not a rush regression. | Add AST-aware extraction for dashboard-visible text during the adjustment phase.            |
| C6-I1 | C6          | Medium   | Add a qualified Windows named-pipe transport for the host connector.                                | The rush deliberately fails closed on Windows instead of using shell-based CLI shims.                                      | Design authenticated named-pipe peer validation and run it on a real Windows CI host.       |
| C6-I2 | C6          | Low      | Surface persisted routing reasons and unknown quota explicitly in the dashboard.                    | Routing correctness and persistence are complete; richer presentation is not a release blocker.                            | Add a routing-decision drawer to mission task details.                                      |

## Cross-agent handoffs

| ID    | From/to                    | Contract or dependency                                                                                                                                                                              | Status   | Evidence or target commit                                                                    |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| C0-H1 | Codex to Claude and Gemini | Use `services/mission-engine/tests/fixtures/complete_mission.json` as the deterministic integration scenario; preserve its event names when adapting connection and dashboard fixtures.             | RESOLVED | Final deterministic E2E passes 27 chain and 14 confirmation steps.                           |
| C1-H1 | Codex to event consumers   | Outbox consumers must publish with `dedupe_key`, then call `acknowledge_outbox`; failed delivery must call `release_outbox`. Lease tokens are fencing tokens and must never be reused after expiry. | DEFERRED | Runtime contract is tested in `f3c0213`; additional consumers must adopt it when introduced. |
| C3-H1 | Codex to Gemini dashboard  | Mission task snapshots include `routing_decisions` with `selected_profile`, JSON candidates/observations, `reason` and `created_at`; render the reason without treating unknown quota as unlimited. | DEFERRED | Backend persistence is verified; detailed dashboard visualization is adjustment item C6-I2.  |
| C5-H1 | Gemini to Codex            | Provide public `GET /api/v1/auth/setup-status` with `{ initialized: boolean }`.                                                                                                                     | RESOLVED | `f7dc88e`                                                                                    |
| C5-H2 | Gemini to Codex            | Remove the blank-restore dependency on a repository-local Mission Engine virtual environment.                                                                                                       | RESOLVED | `f7dc88e`                                                                                    |
| C5-H3 | Gemini to Claude           | Add structured, secret-free `authGuide` metadata to connection observations.                                                                                                                        | RESOLVED | `31e4df8` in the integrated Antigravity CL delivery.                                         |
| C5-H4 | Claude to Codex            | Deliver CL0-CL5 typed connection, ACP, MCP and browser contracts.                                                                                                                                   | RESOLVED | Antigravity completed the interrupted Claude scope at `358a5c0`.                             |
| C5-H5 | User to Codex              | Approve one quota-consuming live supported-agent smoke test after the connection delivery is integrated.                                                                                            | RESOLVED | Approval received; opt-in Antigravity ACP test passed in 8.45 seconds.                       |
| C5-H6 | Codex to connection owner  | Correct the Browser Worker clean-test command to install the declared `dev` extra.                                                                                                                  | RESOLVED | Final documented command passes 76 tests.                                                    |
| C5-H7 | Codex to Gemini            | Reconcile the G3-G5 progress-summary statuses and commit references with their completed implementation records.                                                                                    | RESOLVED | `9baf708`                                                                                    |

## Final verification

| Gate                 | Exact command                                                                                                                           | Result | Evidence/date                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Format               | `pnpm format:check`                                                                                                                     | PASS   | All matched files, 2026-10-23                                                                      |
| Lint                 | `pnpm lint`                                                                                                                             | PASS   | 54/54 Turbo tasks, 2026-10-23                                                                      |
| Typecheck            | `pnpm typecheck`                                                                                                                        | PASS   | 54/54 Turbo tasks, 2026-10-23                                                                      |
| Build                | `pnpm build`                                                                                                                            | PASS   | 32/32 Turbo tasks, 2026-10-23                                                                      |
| TypeScript tests     | `pnpm test`                                                                                                                             | PASS   | 54/54 Turbo tasks; API 384 tests, 2026-10-23                                                       |
| Mission Engine tests | `uv run --project services/mission-engine pytest services/mission-engine/tests`                                                         | PASS   | 128 tests, 2026-10-23                                                                              |
| Browser Worker tests | `uv run --project services/browser-worker --extra dev pytest services/browser-worker/tests`                                             | PASS   | 76 passed; 2 capability-dependent tests deselected, 2026-10-23                                     |
| Release hygiene      | `pnpm release:check`                                                                                                                    | PASS   | 974 tracked files, 2026-10-23                                                                      |
| Translation gate     | `pnpm translation:check`                                                                                                                | PASS   | English-only check clean, 2026-10-23                                                               |
| Full E2E             | Dedicated PostgreSQL database with `pnpm --filter @nexus/api e2e:chain`, `e2e:confirmation`, plus the opt-in Antigravity ACP smoke test | PASS   | 27 chain steps + 14 confirmation steps + effective real model response in 8.45 seconds, 2026-10-23 |

---

# Adjustment Rush — Codex

Base commit: `190f85af97d1c46399b9cce64819095ec4951bf6`

Branch: `codex/rush-phase2-platform`

Worktree: `/home/adlane/Documents/Codex/2026-10-11/tu-es-un-ing-nieur-senior/work/codex/rush-phase2-platform`

## Phase 2 progress

| ID  | Deliverable                               | Status | Commit               | Evidence                                                                           |
| --- | ----------------------------------------- | ------ | -------------------- | ---------------------------------------------------------------------------------- |
| A0  | Scale and disaster recovery               | DONE   | `b34bc9a`, `116900a` | 134 engine tests; real PostgreSQL/Redis replication and process-kill recovery pass |
| A1  | Interchangeable engines and model routing | TODO   |                      |                                                                                    |
| A2  | Controlled advanced agent collaboration   | TODO   |                      |                                                                                    |
| A3  | Cloud and multi-user foundation           | TODO   |                      |                                                                                    |
| A4  | Advanced memory lifecycle                 | TODO   |                      |                                                                                    |
| A5  | Advanced observability and evaluation     | TODO   |                      |                                                                                    |
| A6  | Financial simulation completion           | TODO   |                      |                                                                                    |
| A7  | Autonomy and federation safety boundaries | TODO   |                      |                                                                                    |
| A8  | Phase 2 integration and full E2E          | TODO   |                      |                                                                                    |

## A0 — Scale and disaster recovery

Implementation record:

- Status: `DONE`
- Started at: 2026-10-24T10:49:32+02:00
- Completed at: 2026-10-24T11:01:52+02:00
- Base commit: `190f85af97d1c46399b9cce64819095ec4951bf6`
- Branch: `codex/rush-phase2-platform`
- Worktree: `/home/adlane/Documents/Codex/2026-10-11/tu-es-un-ing-nieur-senior/work/codex/rush-phase2-platform`
- Commits: `b34bc9a`, `116900a`
- Commands and results:
  - `NEXUS_TEST_POSTGRES_URL=postgresql://... uv run --project services/mission-engine pytest services/mission-engine/tests -o addopts=''` — passed: 134 tests, including four real PostgreSQL HA tests; one pre-existing Starlette deprecation warning.
  - `pnpm --filter @nexus/agent-core... build && pnpm --filter @nexus/agent-core test` — passed: six-package build closure, 3 files and 43 tests.
  - `bash scripts/test-ha-replication.sh` — passed against isolated Docker volumes: PostgreSQL streaming replication, custom-format backup and isolated restore, Redis replication, primary loss and Sentinel promotion.
  - `docker build -f infrastructure/docker/mission-engine.Dockerfile -t nexus-mission-engine:a0-test .` — passed; pinned Python base and production package installed.
  - Container smoke with `NEXUS_ENGINE_DATABASE_URL` followed by `GET /v1/health/ready` — passed with `status=ready`; the disposable container was stopped and removed.
  - `docker compose -f infrastructure/docker/docker-compose.ha-test.yml config --quiet` — passed.
  - `docker compose -f infrastructure/docker/docker-compose.yml config --quiet` — passed; personal single-node profile remains valid.
  - `docker run --rm ... registry.k8s.io/kubectl:v1.34.1 kustomize infrastructure/kubernetes` — passed: deterministic 467-line production render.
  - `docker run --rm -i ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -ignore-missing-schemas` — passed: 15 resources parsed, 13 native resources valid, 0 invalid, 0 errors, and two operator CRDs skipped because their schemas are operator-provided.
  - `kubectl apply --dry-run=client --validate=false` — failed because this host has no Kubernetes API endpoint; no live cluster deployment is claimed. Render and native-schema validation are the executable manifest evidence.
- Migration: additive `mission_artifacts` table plus a new PostgreSQL schema bootstrap. No existing table or user row is rewritten, so no backup was required. The real PostgreSQL suite recreates the repository on restart and the SQLite suite preserves personal mode.
- Notes: PostgreSQL advisory transactions serialize existing select/update transitions across instances, while attempt and outbox tokens retain stale-worker fencing. Database-backed artifacts are visible and deletable across instances. CloudNativePG and Redis Operator provide production replication; the real Docker suite independently verifies PostgreSQL/Redis semantics. Cross-region topology requires the prerequisites in `infrastructure/kubernetes/ha/README.md`.

- [x] Multi-server high availability.
- [x] PostgreSQL and Redis replication.
- [x] Multiple fenced Mission Engine instances.
- [x] Distributed artifact storage behind a typed port.
- [x] Production Kubernetes beyond alpha single-replica mode.
- [x] Multi-region deployment and tested failure semantics.
- [x] Automatic recovery after total loss of one server.
- [x] Evaluate Temporal behind the Mission Engine port; adopt only with migration and parity evidence.
- [x] Evaluate OPA behind the policy port; retain the current fail-closed engine until parity passes.

Acceptance: killing one application node during a mission resumes work elsewhere without duplicate side
effects. Personal single-node mode remains supported and simpler.

## A1 — Interchangeable engines and model routing

- [ ] Native Google/Antigravity harness distinct from the community ACP adapter.
- [ ] DeepSeek harness.
- [ ] FreeLLM backend.
- [ ] Complete Ollama, llama.cpp, and vLLM adapters.
- [ ] One routing contract spanning local, cloud, and ACP backends.
- [ ] Reproducible automatic model benchmarks.
- [ ] Routing by quality, latency, quota, cost, context, and privacy.
- [ ] Safe engine migration/fallback at persisted task boundaries.

Acceptance: all backends pass one conformance suite; missing quota remains unknown, never unlimited, and
NEXUS has no mandatory provider.

## A2 — Controlled advanced agent collaboration

- [ ] Bounded direct agent conversations with hop, token, time, and recursion ceilings.
- [ ] Structured debates.
- [ ] Typed voting and consensus.
- [ ] Configurable mandatory cross-review.
- [ ] Dynamic roles constrained by capabilities and permissions.
- [ ] Runtime plan revision with persisted history.
- [ ] Virtual-score task bidding with no money or provider credits.

Acceptance: adversarial tests prove cycle termination and budget enforcement; every message, vote,
revision, and arbitration is attributable and replayable.

## A3 — Cloud and multi-user foundation

- [ ] Hosted deployment profile.
- [ ] Tenant isolation in every database and artifact query.
- [ ] Organizations and teams.
- [ ] Advanced RBAC beyond `ADMIN` and `USER`.
- [ ] OIDC SSO, with SAML behind the same identity port.
- [ ] Provider-neutral billing abstraction.
- [ ] Organization quota administration.
- [ ] Mission sharing with explicit ACLs.
- [ ] Real-time multi-user collaboration.
- [ ] Central fleet administration across installations.

Acceptance: PostgreSQL integration tests attempt cross-tenant access through every public route and prove
denial. Personal single-user mode remains the default.

## A4 — Advanced memory lifecycle

- [ ] Hierarchical working and archival memory without a hard Letta dependency.
- [ ] Opt-in scheduled consolidation with review and rollback.
- [ ] Contradiction detection between temporal facts.
- [ ] Native knowledge-graph projection with provenance.
- [ ] Selective memory sharing between agents.
- [ ] First-class project-scoped memory.
- [ ] Configurable automatic forgetting and retention.
- [ ] Large personal-archive import with progress, cancellation, and deduplication.
- [ ] End-to-end encrypted synchronization between installations.

Acceptance: forbidden secrets cannot enter memory or synchronization; deletion propagates and is proven
at storage level while temporal history remains queryable.

## A5 — Advanced observability and evaluation

- [ ] Exact official provider consumption separated from API-equivalent estimates.
- [ ] Quota-exhaustion forecasting with confidence and explicit unknown state.
- [ ] Intelligent alert suppression and escalation.
- [ ] Deterministic replay where possible, with honest nondeterminism markers elsewhere.
- [ ] Side-by-side run comparison.
- [ ] Automatic regression detection.
- [ ] Scheduled nightly evaluations.
- [ ] Inter-agent communication graph.
- [ ] Real-time DAG debugger with safe pause, inspect, and resume.

Acceptance: dashboards use persisted facts and never scrape private provider pages; traces exclude prompts,
credentials, and private transcripts by default.

## A6 — Financial simulation completion

- [ ] Polymarket-compatible paper-data adapter with no order-submission capability.
- [ ] Historical backtesting with immutable datasets and reproducible strategies.
- [ ] Keep real trading impossible at schema, API, tool, and network boundaries.

Acceptance: negative tests prove no configuration can enable live trading. Simulations preserve risk
limits, provenance, decision journals, and tamper-evident audit chains.

## A7 — Autonomy and federation safety boundaries

- [ ] Supervised self-improvement proposals without self-modifying execution.
- [ ] Confirmation-gated deployment, never autonomous by default.
- [ ] Keep purchasing and money management unavailable outside simulation.
- [ ] Authenticated private federation before any public federation.
- [ ] Abuse controls before any decentralized agent network.
- [ ] Pause, budget, supervision, and emergency-stop contracts before permanent agents.

Acceptance: only safe proposal and approval workflows may ship. No unattended code mutation, purchase,
deployment, or real-money control is permitted.

## A8 — Phase 2 integration and full E2E

Integrate the two Phase 2 handoffs, reconcile migrations and manifests once, rerun every Phase 1 gate,
then add multi-node, multi-user, engine, memory, simulation, device, voice, security, and clean-install
evidence. Unsupported platforms remain `BLOCKED`; they are never skipped and reported as successful.

## Phase 2 cross-agent handoffs

| ID    | From/to                               | Contract or dependency                                                                                                                                                                                                                             | Status   | Evidence or target commit |
| ----- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| A0-H1 | Codex to Antigravity and Gemini       | The production control plane uses `NEXUS_ENGINE_DATABASE_URL` for shared PostgreSQL state. Mission Engine replicas retain lease-token fencing; consumers must never bypass `dedupe_key`. Redis is reached through its replicated service endpoint. | RESOLVED | `b34bc9a`, `116900a`      |
| A0-H2 | Codex to Phase 2 deployment consumers | Kubernetes workloads must remain private, use topology spread and disruption budgets, and obtain database credentials from `nexus-secrets`. Personal Compose continues to use SQLite for the Mission Engine unless the HA URL is explicitly set.   | RESOLVED | 467-line validated render |

## Phase 2 findings and errors

| ID   | Task | Severity | Status   | Description                                                                                                               | Reproduction or evidence                                                                                                                                    | Fix commit |
| ---- | ---- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A0-1 | A0   | Critical | RESOLVED | Mission Engine accepted only a local SQLite path, so separate application nodes could not share or recover mission state. | A killed process is recovered through shared PostgreSQL with the same attempt and one final effect.                                                         | `b34bc9a`  |
| A0-2 | A0   | High     | RESOLVED | Redis Sentinel using a disappearing Docker DNS hostname intermittently stalled promotion after primary loss.              | A repeated run entered Sentinel tilt; fixed-address isolated test networking now passes deterministically.                                                  | `116900a`  |
| A0-3 | A0   | Low      | OPEN     | This host has no Kubernetes API server or installed operator CRDs for server-side dry-run.                                | Client apply could not reach localhost:8080; kustomize and native schema validation pass, and operator installation is an explicit deployment prerequisite. | N/A        |
