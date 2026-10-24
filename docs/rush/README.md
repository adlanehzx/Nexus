# NEXUS implementation rush

This directory is the coordination contract for the implementation rush. The objective is a complete
first-run journey:

> A new user installs NEXUS, connects at least one existing AI account from the dashboard, submits a
> mission, watches NEXUS execute it with tools and fallbacks, and receives a verified result without
> using a shell.

The rush deliberately favors a complete, testable product path over visual polish and advanced
optimizations. Security boundaries, data migrations, secret handling, and critical tests are never
deferred.

## Agent assignments

| Agent  | Work file              | Exclusive responsibility                                               |
| ------ | ---------------------- | ---------------------------------------------------------------------- |
| Codex  | [CODEX.md](CODEX.md)   | Durable orchestration, context, memory, quotas, fallback and final E2E |
| Claude | [CLAUDE.md](CLAUDE.md) | Connections, ACP, MCP and browser execution security                   |
| Gemini | [GEMINI.md](GEMINI.md) | Onboarding UX, devices, workers, packaging and user documentation      |

Each agent must read this file and only its own work file before changing code. Agents must use an
isolated Git branch and worktree. No agent may merge, rebase, force-push, or push to `master`.

## Mandatory workflow

For every numbered task in an agent file:

1. Record the base commit and set the task to `IN_PROGRESS` before editing code.
2. Implement the smallest complete vertical slice.
3. Add or update tests that can fail when the behavior regresses.
4. Run the task-specific verification and record the exact command and result.
5. Update the task's implementation record, findings table and follow-up table.
6. Commit code and documentation together with a DCO sign-off (`git commit -s`).
7. Mark the task `DONE` only when its acceptance criteria and evidence are complete.

Do not erase findings after fixing them. Mark them `RESOLVED` and link the fixing commit. This leaves
an audit trail for the adjustment phase.

## Status vocabulary

- `TODO`: not started.
- `IN_PROGRESS`: owned and actively being changed.
- `BLOCKED`: cannot continue; the exact dependency or decision is recorded.
- `DONE`: implemented and verified against all acceptance criteria.
- `DEFERRED`: consciously moved to the post-rush adjustment phase with a reason.

## Shared safety rules

- Never print, store in Git, return through an API, or place in fixtures any real credential, session,
  cookie, OAuth token, API key or private key.
- Reuse official login and local CLI session mechanisms. Do not extract private tokens from another
  application's storage.
- No paid API call, quota-consuming live test or external side effect without explicit user approval.
- Keep production execution fail-closed. Tests may skip only when they prove and report a missing host
  capability; they may not weaken production behavior.
- Preserve existing conversations, accounts and user data. Back up before destructive or non-additive
  migrations.
- Keep all repository code, comments, documentation and user-facing strings in English, except the
  documented multilingual product allowlist.
- Do not add a second implementation when a NEXUS service already owns the responsibility.
- Never silently change an API contract shared with another agent. Record it under `Cross-agent
handoffs` first.

## Ownership and collision policy

The detailed file ownership is listed in each agent file. If a task requires a file owned by another
agent:

1. Do not edit it directly.
2. Record the required contract in `Cross-agent handoffs`.
3. Implement against a typed port or fixture when possible.
4. Let Codex integrate the contract after both branches are complete.

Root manifests, the lockfile, shared database schema, shared generated clients, root CI workflows and
shared package exports are integration-owned by Codex. Claude and Gemini must list required changes
without committing them unless their task cannot compile otherwise. Any unavoidable shared change must
be isolated in its own commit and declared in the work file.

## Completion gates

The rush is complete only when all three work files are `DONE` and Codex records evidence for:

- a clean installation from a blank environment;
- dashboard-only setup for the normal user journey;
- connection of at least one supported agent without exposing its credentials;
- one real end-to-end mission producing a useful model response;
- durable pause, restart and resume during a mission;
- agent fallback after a controlled failure or exhausted budget;
- MCP and browser actions passing through permissions and audit logging;
- no critical security finding, no release-hygiene violation and no French product string regression;
- build, lint, typecheck, unit, integration and relevant E2E suites passing.

## Integration order

1. Claude's connection and execution contracts.
2. Gemini's onboarding and device experience, rebased only by the integrator.
3. Codex's orchestration work and cross-agent adapters.
4. One lockfile regeneration and one database migration reconciliation.
5. Full clean verification and the manual real-agent smoke test.

The post-rush adjustment phase starts only after this integration gate. Its input is the unresolved
findings and improvements preserved in the three agent files.

## Adjustment Rush — Phase 2

Phase 1 is complete. Phase 2 contains only partial or missing capabilities, assigned in the appended
sections of `CODEX.md`, `CLAUDE.md`, and `GEMINI.md`.

| Agent              | Exclusive Phase 2 responsibility                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Codex              | Scale, engines, collaboration, cloud/multi-user, memory, observability, simulation, and final integration |
| Claude/Antigravity | Marketplaces, visual computer control, external automations, plugins, and advanced security               |
| Gemini             | Mobile distribution, hardware workers, voice, offline device experience, and Phase 2 dashboard UX         |

Phase 2 rules:

1. Start from the same `master` commit, record it, and use an isolated worktree.
2. Follow task order. Interfaces, documentation, mocks, and untested platform claims are not `DONE`.
3. Every completed item requires an executable regression test on its target platform.
4. Record cross-owner contracts before touching shared files; Codex reconciles shared migrations and manifests once.
5. Preserve fail-closed behavior. Phase 2 must not enable real-money trading, autonomous purchasing,
   public arbitrary-code execution, self-modifying execution, or unsupervised deployment.
6. Preserve Phase 1 evidence and append every new finding, correction, limitation, and deferred improvement.
7. Codex integrates only after the other work files provide clean, signed handoff commits.
