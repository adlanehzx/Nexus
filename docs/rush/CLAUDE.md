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

| ID  | Deliverable                                      | Status | Commit | Evidence |
| --- | ------------------------------------------------ | ------ | ------ | -------- |
| CL0 | Baseline connection and threat-model fixtures    | TODO   |        |          |
| CL1 | Truthful CLI, adapter and session detection      | TODO   |        |          |
| CL2 | Secure ACP connector and multi-account contracts | TODO   |        |          |
| CL3 | MCP catalog, OAuth and per-server isolation      | TODO   |        |          |
| CL4 | Browser sessions, permissions and audit          | TODO   |        |          |
| CL5 | Contract tests and integration handoff           | TODO   |        |          |

## CL0 — Baseline connection and threat-model fixtures

Capture the supported connection states and attack surfaces before changing behavior.

Acceptance criteria:

- Fixtures distinguish CLI presence, adapter availability, account authentication and ACP readiness.
- Codex, Claude and Antigravity provenance remains explicit and honest.
- Tests cover command injection, hostile output, symlinks, oversized requests, timeouts and replay.
- No test reads a real user credential directory.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

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

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

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

| ID  | Task | Severity | Status | Description | Reproduction or evidence | Fix commit |
| --- | ---- | -------- | ------ | ----------- | ------------------------ | ---------- |
|     |      |          |        |             |                          |            |

## Improvements for the adjustment phase

| ID  | Source task | Priority | Improvement | Why deferred | Suggested next action |
| --- | ----------- | -------- | ----------- | ------------ | --------------------- |
|     |             |          |             |              |                       |

## Cross-agent handoffs

| ID  | From/to | Contract or dependency | Status | Evidence or target commit |
| --- | ------- | ---------------------- | ------ | ------------------------- |
|     |         |                        |        |                           |

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
