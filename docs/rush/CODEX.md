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

| ID  | Deliverable                                    | Status  | Commit    | Evidence                                                              |
| --- | ---------------------------------------------- | ------- | --------- | --------------------------------------------------------------------- |
| C0  | Baseline and executable acceptance scenarios   | DONE    | `c7d013a` | 113 Python, 42 Agent Core and 109 Memory tests passed                 |
| C1  | Durable mission lifecycle and restart recovery | DONE    | `f3c0213` | 9 lifecycle scenarios and 122 engine tests passed                     |
| C2  | Context, memory and token-budget management    | DONE    | `f535de8` | 43 Agent Core and 109 Memory tests passed                             |
| C3  | Health, quota-aware routing and agent fallback | DONE    | `09f79b0` | 18 routing repository and 123 engine tests passed                     |
| C4  | Human confirmation and safe retry semantics    | DONE    | `bba856d` | 36 bridge, 43 Agent Core and 128 engine tests passed                  |
| C5  | Cross-agent integration and full product E2E   | BLOCKED | `f7dc88e` | Local E2E passes; Claude delivery and live-agent approval are missing |
| C6  | Rush closure report and adjustment backlog     | TODO    |           |                                                                       |

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

- Status: `BLOCKED`
- Started at: 2026-10-23T15:14:44+02:00
- Completed at:
- Commit: `f7dc88e2ccda3df7dd5493b82727c45779f150b9`, `a845e651af709ceafe51b7893265571d8ae9aa79`
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
- Notes: Gemini commits `acd608f`, `9abb0f9`, `4821891`, `627e81e`, `9ecaa21`, `94c6b79` and `0d04229` were cherry-picked without conflict. The setup-status and blank-restore handoffs are resolved by `f7dc88e`. The blank-install backup was encrypted, temporary (320 KiB), restored successfully and removed by the test trap; its two dedicated databases were also removed. Mission Engine migrations remain additive and their legacy-row tests pass. The deterministic local journey proves submission, decomposition, parallel execution, controlled failure, fallback, restart, confirmation, review, synthesis and owner-visible verified output. C5 remains blocked because no `claude/rush-connections-tools` delivery exists, `docs/rush/CLAUDE.md` remains entirely `TODO`, unified MCP/browser audit evidence is therefore absent, and the required live supported-agent smoke test needs explicit quota approval. No external provider call was made.

## C6 — Rush closure report and adjustment backlog

Run all release gates from clean state and turn every unresolved observation from all three files into a
prioritized adjustment backlog. Do not call the rush complete with missing evidence.

Acceptance criteria:

- All completion gates in `README.md` have exact evidence.
- Every cross-agent handoff is resolved or explicitly deferred.
- Critical and high-severity findings are zero.
- Remaining UX, performance and maintainability work is ranked for the adjustment phase.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## Findings and errors

Add a row after every numbered task, even when the result is `None found`.

| ID   | Task | Severity | Status   | Description                                                                                                                                               | Reproduction or evidence                                                                                                                      | Fix commit |
| ---- | ---- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C0-1 | C0   | High     | RESOLVED | The documented Mission Engine command could not install `pytest` because test dependencies were only an optional extra.                                   | `uv run --project services/mission-engine pytest -q` exited 2 with `Failed to spawn: pytest`.                                                 | `c7d013a`  |
| C0-2 | C0   | Medium   | RESOLVED | Unscoped pytest collected the browser-worker suite from the repository root.                                                                              | The command collected 113 items then failed importing `app`; the scoped command passes 113 tests and the final gate now names the suite path. | `c526f6f`  |
| C0-3 | C0   | Medium   | RESOLVED | Direct package tests require built internal workspace exports.                                                                                            | Baseline Agent Core/Memory runs failed package resolution; dependency-closure build followed by both suites passes.                           | `c7d013a`  |
| C1-1 | C1   | High     | RESOLVED | Mission outbox events had no claim or acknowledgement fencing, allowing concurrent or restarted publishers to duplicate delivery.                         | The restart test reclaims the same event and rejects the stale publisher token; only the current lease can acknowledge it.                    | `f3c0213`  |
| C2-1 | C2   | High     | RESOLVED | Agent Core persisted messages but discarded assembled context during confirmation suspension, so resumed calls lost decisions, constraints and citations. | A regression test suspends, reloads stored state, resumes, and observes the same citation in the second model system prompt.                  | `f535de8`  |
| C2-2 | C2   | Low      | RESOLVED | Direct Agent Core typecheck read the previous Memory build output after the cross-package type changed.                                                   | Rebuilding Memory followed by both package typechecks passes.                                                                                 | `f535de8`  |
| C3-1 | C3   | High     | RESOLVED | Routing selected healthy or fallback profiles but did not persist candidates, observations or the audit reason.                                           | Mission snapshots now contain routing decisions; tests prove quota-exhausted fallback and explicit unknown quota.                             | `09f79b0`  |
| C4-1 | C4   | High     | RESOLVED | Mission Engine collapsed rejection and expiry into one category and treated cancellation as a generic empty response.                                     | Bridge and repository tests prove distinct rejection, expiry and cancellation states with zero retry.                                         | `bba856d`  |
| C5-1 | C5   | Critical | OPEN     | The required Claude rush delivery is absent, so secure connection, ACP, MCP isolation and browser-audit acceptance cannot be integrated or certified.     | No `claude/rush-connections-tools` branch exists; all CL0-CL5 rows in `docs/rush/CLAUDE.md` remain `TODO`.                                    | —          |
| C5-2 | C5   | High     | OPEN     | A live supported-agent answer cannot be tested without the user's explicit approval to consume provider quota.                                            | No external provider call was made; the deterministic ACP E2E passes 27 steps locally.                                                        | —          |
| C5-3 | C5   | Medium   | RESOLVED | First-run UI lacked an unambiguous public probe for whether administrator setup was already initialized.                                                  | `GET /api/v1/auth/setup-status` changes from false to true only after account creation; focused test passes.                                  | `f7dc88e`  |
| C5-4 | C5   | Medium   | RESOLVED | Blank-machine restore assumed a pre-existing Mission Engine `.venv/bin/python`, contradicting a clean installation.                                       | The script now uses `uv run --project`; the blank archive journey passes 24 steps with 0 failures.                                            | `f7dc88e`  |
| C5-5 | C5   | Medium   | RESOLVED | Integrated Gemini files and the C2 aggregate failed repository format/lint gates.                                                                         | Initial format failed on 9 files and lint reported 2 errors; reruns pass 54 lint tasks and the global format gate.                            | `a845e65`  |
| C5-6 | C5   | Medium   | OPEN     | Claude's documented Browser Worker verification command omits its declared `dev` extra and cannot spawn pytest from a clean environment.                  | Documented command exits 2; adding `--extra dev` passes 76 tests with 2 real-browser tests deselected.                                        | —          |
| C5-7 | C5   | Low      | RESOLVED | The first two local E2E invocations omitted their required dedicated `DATABASE_URL`.                                                                      | Both stopped at 0 steps; exact reruns against `nexus_c5_e2e` pass 27/27 and 14/14 steps, then the database was dropped.                       | N/A        |

## Improvements for the adjustment phase

Record improvements that are useful but not required for the rush acceptance criteria.

| ID    | Source task | Priority | Improvement                                                                                         | Why deferred                                                                                                               | Suggested next action                                                                       |
| ----- | ----------- | -------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C0-I1 | C0          | Medium   | Replace deprecated Starlette `httpx` compatibility path.                                            | The warning does not affect correctness or rush acceptance.                                                                | Upgrade the compatible FastAPI/Starlette test client stack after the rush.                  |
| C2-I1 | C2          | Medium   | Add explicit retention expiry for completed Agent Core context snapshots.                           | Current run-store retention governs snapshots and restart recovery requires them while active.                             | Delete snapshot text after terminal-run retention while retaining aggregate usage metadata. |
| C5-I1 | C5          | Medium   | Expand the English-product-string gate beyond structured `userMessage` fields to JSX fallback text. | The current gate passes while older dashboard JSX can still contain a French fallback string; it is not a rush regression. | Add AST-aware extraction for dashboard-visible text during the adjustment phase.            |

## Cross-agent handoffs

| ID    | From/to                    | Contract or dependency                                                                                                                                                                              | Status   | Evidence or target commit                                                                                   |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| C0-H1 | Codex to Claude and Gemini | Use `services/mission-engine/tests/fixtures/complete_mission.json` as the deterministic integration scenario; preserve its event names when adapting connection and dashboard fixtures.             | OPEN     | Target C5 integration                                                                                       |
| C1-H1 | Codex to event consumers   | Outbox consumers must publish with `dedupe_key`, then call `acknowledge_outbox`; failed delivery must call `release_outbox`. Lease tokens are fencing tokens and must never be reused after expiry. | OPEN     | `f3c0213`                                                                                                   |
| C3-H1 | Codex to Gemini dashboard  | Mission task snapshots include `routing_decisions` with `selected_profile`, JSON candidates/observations, `reason` and `created_at`; render the reason without treating unknown quota as unlimited. | OPEN     | `09f79b0`                                                                                                   |
| C5-H1 | Gemini to Codex            | Provide public `GET /api/v1/auth/setup-status` with `{ initialized: boolean }`.                                                                                                                     | RESOLVED | `f7dc88e`                                                                                                   |
| C5-H2 | Gemini to Codex            | Remove the blank-restore dependency on a repository-local Mission Engine virtual environment.                                                                                                       | RESOLVED | `f7dc88e`                                                                                                   |
| C5-H3 | Gemini to Claude           | Add structured, secret-free `authGuide` metadata to connection observations.                                                                                                                        | OPEN     | Awaiting Claude CL1/CL2                                                                                     |
| C5-H4 | Claude to Codex            | Deliver CL0-CL5 typed connection, ACP, MCP and browser contracts on `claude/rush-connections-tools`.                                                                                                | BLOCKED  | Branch absent; Claude file remains TODO                                                                     |
| C5-H5 | User to Codex              | Approve one quota-consuming live supported-agent smoke test after the Claude delivery is integrated.                                                                                                | OPEN     | Explicit approval required                                                                                  |
| C5-H6 | Codex to Claude            | Correct the Browser Worker clean-test command to install the declared `dev` extra.                                                                                                                  | OPEN     | `uv run --project services/browser-worker --extra dev pytest services/browser-worker/tests` passes 76 tests |

## Final verification

| Gate                 | Exact command                                                                                                                                                                                                | Result  | Evidence/date                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------- |
| Format               | `pnpm format:check`                                                                                                                                                                                          | PASS    | All matched files, 2026-10-23                                                               |
| Lint                 | `pnpm lint`                                                                                                                                                                                                  | PASS    | 54/54 Turbo tasks, 2026-10-23                                                               |
| Typecheck            | `pnpm typecheck`                                                                                                                                                                                             | PASS    | 54/54 Turbo tasks, 2026-10-23                                                               |
| Build                | `pnpm build`                                                                                                                                                                                                 | PASS    | 32/32 Turbo tasks, 2026-10-23                                                               |
| TypeScript tests     | `pnpm test`                                                                                                                                                                                                  | PASS    | 54/54 Turbo tasks; API 383 tests, 2026-10-23                                                |
| Mission Engine tests | `uv run --project services/mission-engine pytest services/mission-engine/tests`                                                                                                                              | PASS    | 128 tests, 2026-10-23                                                                       |
| Release hygiene      | `pnpm release:check`                                                                                                                                                                                         | PASS    | 943 tracked files, 2026-10-23                                                               |
| Translation gate     | `pnpm translation:check`                                                                                                                                                                                     | PASS    | English-only check clean, 2026-10-23                                                        |
| Full E2E             | `DATABASE_URL=postgresql://nexus:nexus_dev_password@127.0.0.1:15432/nexus_c5_e2e?schema=public pnpm --filter @nexus/api e2e:chain` and the same environment with `pnpm --filter @nexus/api e2e:confirmation` | BLOCKED | Local runs pass 27 + 14 steps; Claude delivery and approved live-agent smoke remain missing |
