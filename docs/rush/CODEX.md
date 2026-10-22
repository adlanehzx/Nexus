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

| ID  | Deliverable                                    | Status | Commit    | Evidence                                              |
| --- | ---------------------------------------------- | ------ | --------- | ----------------------------------------------------- |
| C0  | Baseline and executable acceptance scenarios   | DONE   | `c7d013a` | 113 Python, 42 Agent Core and 109 Memory tests passed |
| C1  | Durable mission lifecycle and restart recovery | TODO   |           |                                                       |
| C2  | Context, memory and token-budget management    | TODO   |           |                                                       |
| C3  | Health, quota-aware routing and agent fallback | TODO   |           |                                                       |
| C4  | Human confirmation and safe retry semantics    | TODO   |           |                                                       |
| C5  | Cross-agent integration and full product E2E   | TODO   |           |                                                       |
| C6  | Rush closure report and adjustment backlog     | TODO   |           |                                                       |

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

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

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

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

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

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## C4 — Human confirmation and safe retry semantics

Complete the real confirmation lifecycle for risky tools and external side effects.

Acceptance criteria:

- A risky action becomes durably `awaiting_confirmation`.
- Approval, refusal, expiry and cancellation have distinct terminal behavior.
- Waiting consumes neither a worker lease nor a retry attempt.
- A restart while waiting preserves the request.
- Approval authorizes exactly the displayed action, not a mutable future payload.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

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

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

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

| ID   | Task | Severity | Status   | Description                                                                                                             | Reproduction or evidence                                                                                                                      | Fix commit         |
| ---- | ---- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| C0-1 | C0   | High     | RESOLVED | The documented Mission Engine command could not install `pytest` because test dependencies were only an optional extra. | `uv run --project services/mission-engine pytest -q` exited 2 with `Failed to spawn: pytest`.                                                 | `c7d013a`          |
| C0-2 | C0   | Medium   | RESOLVED | Unscoped pytest collected the browser-worker suite from the repository root.                                            | The command collected 113 items then failed importing `app`; the scoped command passes 113 tests and the final gate now names the suite path. | C0 evidence commit |
| C0-3 | C0   | Medium   | RESOLVED | Direct package tests require built internal workspace exports.                                                          | Baseline Agent Core/Memory runs failed package resolution; dependency-closure build followed by both suites passes.                           | `c7d013a`          |

## Improvements for the adjustment phase

Record improvements that are useful but not required for the rush acceptance criteria.

| ID    | Source task | Priority | Improvement                                              | Why deferred                                                | Suggested next action                                                      |
| ----- | ----------- | -------- | -------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| C0-I1 | C0          | Medium   | Replace deprecated Starlette `httpx` compatibility path. | The warning does not affect correctness or rush acceptance. | Upgrade the compatible FastAPI/Starlette test client stack after the rush. |

## Cross-agent handoffs

| ID    | From/to                    | Contract or dependency                                                                                                                                                                  | Status | Evidence or target commit |
| ----- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------- |
| C0-H1 | Codex to Claude and Gemini | Use `services/mission-engine/tests/fixtures/complete_mission.json` as the deterministic integration scenario; preserve its event names when adapting connection and dashboard fixtures. | OPEN   | Target C5 integration     |

## Final verification

| Gate                 | Exact command                                                                   | Result  | Evidence/date |
| -------------------- | ------------------------------------------------------------------------------- | ------- | ------------- |
| Format               | `pnpm format:check`                                                             | NOT RUN |               |
| Lint                 | `pnpm lint`                                                                     | NOT RUN |               |
| Typecheck            | `pnpm typecheck`                                                                | NOT RUN |               |
| Build                | `pnpm build`                                                                    | NOT RUN |               |
| TypeScript tests     | `pnpm test`                                                                     | NOT RUN |               |
| Mission Engine tests | `uv run --project services/mission-engine pytest services/mission-engine/tests` | NOT RUN |               |
| Release hygiene      | `pnpm release:check`                                                            | NOT RUN |               |
| Translation gate     | `pnpm translation:check`                                                        | NOT RUN |               |
| Full E2E             | Record the repository command here                                              | NOT RUN |               |
