# Claude rush work file

## Mission

Own the secure connection and tool-execution plane: turn installed AI CLIs into truthful connection
states, expose ACP safely, and make MCP and browser capabilities installable and operable without
weakening isolation.

## Branch contract

- Suggested branch: `claude/rush-connections-tools`
- Worktree: isolated from `master` and from the Codex and Gemini worktrees
- Base commit: the same `master` commit containing this work file; record its exact SHA before starting
- Push/merge/rebase: forbidden until the user requests integration

## Owned areas

- `packages/connections/**`
- `services/connector/**`
- `packages/mcp/**`
- `packages/browser-client/**`
- `services/browser-worker/**`
- connection, provider-account, MCP and browser API routes/services and their focused tests

Do not implement mission scheduling, memory, dashboard components, device pairing, worker installers or
release packaging. Document required shared manifest, schema or lockfile changes for Codex.

## Progress summary

| ID  | Deliverable                                      | Status | Commit  | Evidence                                                                      |
| --- | ------------------------------------------------ | ------ | ------- | ----------------------------------------------------------------------------- |
| CL0 | Baseline connection and threat-model fixtures    | DONE | acc5968 | 290 focused tests passing across connections and connector packages           |
| CL1 | Truthful CLI, adapter and session detection      | DONE | 31e4df8 | 218 tests passing in @nexus/connections including adapter and authGuide tests |
| CL2 | Secure ACP connector and multi-account contracts | TODO |         |                                                                               |
| CL3 | MCP catalog, OAuth and per-server isolation      | TODO   |         |                                                                               |
| CL4 | Browser sessions, permissions and audit          | TODO   |         |                                                                               |
| CL5 | Contract tests and integration handoff           | TODO   |         |                                                                               |

## CL0 — Baseline connection and threat-model fixtures

Capture the supported connection states and attack surfaces before changing behavior.

Acceptance criteria:

- Fixtures distinguish CLI presence, adapter availability, account authentication and ACP readiness.
- Codex, Claude and Antigravity provenance remains explicit and honest.
- Tests cover command injection, hostile output, symlinks, oversized requests, timeouts and replay.
- No test reads a real user credential directory.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-23T15:35:00+02:00
- Completed at: 2026-10-23T15:40:00+02:00
- Commit: acc59684a02adcb8b9dc4f62d22321c32ee7d5c1
- Commands and results:
  - `pnpm --filter @nexus/connections test`: 6 test files, 177 tests passed.
  - `pnpm --filter @nexus/connector test`: 6 test files, 113 tests passed.
  - `pnpm --filter @nexus/connections format:check && pnpm --filter @nexus/connector format:check`: passed.
  - `pnpm --filter @nexus/connections lint && pnpm --filter @nexus/connector lint`: passed.
- Notes:
  - Verified baseline test suites in `packages/connections/test` and `services/connector/test`.
  - Proved threat-model boundaries: argument array execution without shell interpolation, stdout/stderr credential redaction before truncation, symlink rejection for Unix sockets, payload size and request timeout enforcement, replay rejection via client nonce map.
  - All fixtures run in temporary directories without referencing home credential directories.

## CL1 — Truthful CLI, adapter and session detection

Implement non-destructive provider probes that report evidence and uncertainty without claiming a live
session from `--version` alone.

Acceptance criteria:

- CLI, ACP adapter and authenticated session are separate fields.
- Provider probes use argument arrays and never a shell.
- Output is redacted before truncation, storage or logging.
- Unsupported platforms and unverified probes remain explicit.
- Probe results have timestamps, expiry and actionable but secret-free diagnostics.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-23T15:42:00+02:00
- Completed at: 2026-10-23T15:46:00+02:00
- Commit: 31e4df89745582f059296e832d208761fa0e5270
- Commands and results:
  - `pnpm --filter @nexus/connections build`: succeeded.
  - `pnpm --filter @nexus/connections test`: 8 test files (7 passed, 1 skipped real-agents smoke test), 218 passed.
  - `pnpm --filter @nexus/connections format:check && pnpm --filter @nexus/connections lint`: succeeded.
  - `pnpm --filter @nexus/api test test/connections.test.ts`: 3 tests passed.
  - `pnpm --filter @nexus/dashboard build`: succeeded.
- Notes:
  - CLI, adapter and session authentication states strictly segregated into distinct fields.
  - Package adapter detection implemented independently from CLI executable presence using `PackageResolverPort` and `NodePackageResolver`.
  - Added secret-free structured `authGuide` metadata to `Connection` and `ConnectionObservation` for Gemini dashboard handoff (`C5-H3` / `H-G0-2`).
  - Added host environment variable allowlist extension (`NEXUS_PROBE_ENV_ALLOWLIST`) for version managers (mise/asdf) while strictly stripping secrets.
  - Real agents smoke suite added behind double opt-in (`NEXUS_REAL_AGENT_SMOKE` and `NEXUS_REAL_AGENT_CONVERSATION`).

## CL2 — Secure ACP connector and multi-account contracts

Finish the signed local connector so the API can request safe operations from the user's environment
without copying provider tokens into containers or the database.

Acceptance criteria:

- Persistent identity and replay state survive restart without weakening expiration checks.
- Unix socket permissions and peer assumptions are documented and tested.
- Multiple accounts for one provider have opaque NEXUS IDs and isolated process environments.
- Adding, testing, disabling and revoking an account are typed operations.
- The API receives status and evidence, never raw provider credentials.
- Windows remains explicitly unsupported until a safe no-shell transport exists.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## CL3 — MCP catalog, OAuth and per-server isolation

Provide a secure backend journey for installing, configuring, testing, enabling and removing MCP
servers.

Acceptance criteria:

- Installation accepts only structured manifests and validated commands.
- Every third-party server has provenance and permission metadata.
- Servers run separately with CPU/memory/process limits, read-only filesystem by default and controlled
  writable mounts.
- Network access is denied or allowlisted per server.
- Secrets are injected only into the target process and are redacted from every response and log.
- OAuth uses an official browser redirect flow with state and PKCE where supported.
- Tool permissions and human confirmation remain enforced by NEXUS.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## CL4 — Browser sessions, permissions and audit

Complete the browser backend as a native NEXUS tool, not as a second agent runtime.

Acceptance criteria:

- Sessions have explicit owner, lifetime, cancellation and cleanup behavior.
- Navigation policy rejects local/private targets and redirect-based SSRF.
- Downloads, uploads, clipboard, credentials and persistent profiles require scoped permissions.
- Tool output is bounded and evidence can include safe citations or screenshots.
- Browser actions share the standard tool audit and confirmation flow.
- Production isolation remains fail-closed when the required host capability is unavailable.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## CL5 — Contract tests and integration handoff

Deliver typed contracts and deterministic fakes that Codex and Gemini can consume without knowing
provider internals.

Acceptance criteria:

- API contracts cover list, detect, connect, test, disconnect and failure recovery.
- A fake ACP provider produces a real streamed answer for CI without external quota.
- Contract tests cover compatibility and sanitized errors.
- Required shared-file changes are listed below.
- The branch passes its complete focused test suite from a clean build.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## Findings and errors

Add a row after every numbered task, even when the result is `None found`.

| ID    | Task | Severity | Status   | Description                                                                                     | Reproduction or evidence                                                               | Fix commit                |
| ----- | ---- | -------- | -------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| CL0-1 | CL0  | Info     | RESOLVED | Worktree package dist artifacts missing on initial checkout, requiring initial workspace build. | Vitest failed resolving `@nexus/shared` until `pnpm build` was run across dependencies. | Resolved by initial build |
| CL1-1 | CL1  | Low      | RESOLVED | Version manager shims (mise) stalled detection under strict minimal env allowlist.              | Detection probes timed out in 10s for shims requiring ambient mise variables.          | 77841a8                   |

## Improvements for the adjustment phase

| ID  | Source task | Priority | Improvement | Why deferred | Suggested next action |
| --- | ----------- | -------- | ----------- | ------------ | --------------------- |
|     |             |          |             |              |                       |

## Cross-agent handoffs

| ID    | From/to          | Contract or dependency                                                                     | Status   | Evidence or target commit |
| ----- | ---------------- | ------------------------------------------------------------------------------------------ | -------- | ------------------------- |
| C5-H3 | Gemini to Claude | Add structured, secret-free `authGuide` metadata to connection observations (also H-G0-2). | RESOLVED | 31e4df8                   |

## Shared-file changes required at integration

| File | Required change | Reason | Related commit/test |
| ---- | --------------- | ------ | ------------------- |
|      |                 |        |                     |

## Final verification

| Gate               | Exact command                                     | Result  | Evidence/date |
| ------------------ | ------------------------------------------------- | ------- | ------------- |
| Connections format | `pnpm --filter @nexus/connections format:check`   | NOT RUN |               |
| Connector format   | `pnpm --filter @nexus/connector format:check`     | NOT RUN |               |
| Focused lint       | Record command                                    | NOT RUN |               |
| Focused typecheck  | Record command                                    | NOT RUN |               |
| Focused build      | Record command                                    | NOT RUN |               |
| Focused tests      | Record command and exact count                    | NOT RUN |               |
| Browser worker     | `uv run --project services/browser-worker pytest` | NOT RUN |               |
| Release hygiene    | `pnpm release:check`                              | NOT RUN |               |
| Translation gate   | `pnpm translation:check`                          | NOT RUN |               |
