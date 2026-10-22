# Gemini rush work file

## Mission

Own the no-shell product journey and distribution surfaces: onboarding, dashboard configuration,
devices, workers, packaging and user-facing documentation. Consume typed backend contracts rather than
reimplementing connection, orchestration or security logic in the UI.

## Branch contract

- Suggested branch: `gemini/rush-onboarding-devices`
- Worktree: isolated from `master` and from the Codex and Claude worktrees
- Base commit: the same `master` commit containing this work file; record its exact SHA before starting
- Push/merge/rebase: forbidden until the user requests integration

## Owned areas

- `apps/dashboard/**`
- `apps/desktop/**`
- `apps/mobile/**`
- `packages/client-core/**`
- `packages/voice/**`
- `packages/devices/**` and `packages/device-policy/**` for client-facing device work
- Windows and Android worker UX, pairing and installer surfaces
- `packaging/**`, Docker/Compose/Kubernetes developer distribution files and user guides

Do not implement provider process probing, ACP transport, MCP sandbox internals, browser security policy,
mission scheduling, context compression or routing decisions.

## Progress summary

| ID  | Deliverable                                   | Status | Commit | Evidence |
| --- | --------------------------------------------- | ------ | ------ | -------- |
| G0  | UX inventory and executable onboarding states | TODO   |        |          |
| G1  | First-run setup wizard                        | TODO   |        |          |
| G2  | Dashboard configuration and connection UX     | TODO   |        |          |
| G3  | Device discovery, pairing and worker install  | TODO   |        |          |
| G4  | Desktop, mobile and voice completion          | TODO   |        |          |
| G5  | Reproducible packaging and public user docs   | TODO   |        |          |

## G0 — UX inventory and executable onboarding states

Map every first-run state to existing or explicitly requested backend contracts. Do not build screens
whose buttons have no real effect.

Acceptance criteria:

- The inventory covers database, API, connector, agent, MCP, browser and worker readiness.
- Loading, empty, success, partial, offline, permission-required and failure states are defined.
- Every action identifies its API contract and durable result.
- Missing backend contracts are recorded under `Cross-agent handoffs` before UI implementation.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## G1 — First-run setup wizard

Build a resumable dashboard wizard for the normal local installation journey.

Acceptance criteria:

- The wizard checks prerequisites without displaying secrets.
- It initializes the database and required services through supported APIs or packaged helpers.
- It detects available agents and guides official login flows.
- It offers MCP, browser and worker setup as optional capabilities.
- Progress survives refresh and can safely resume after restart.
- Every error has a specific recovery action and a copyable sanitized diagnostic.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## G2 — Dashboard configuration and connection UX

Make normal administration possible without shell commands.

Acceptance criteria:

- Users can add, rename, test, enable, disable and revoke agent accounts.
- The UI distinguishes CLI detected, adapter available, login required, connected, degraded and failed.
- Multiple accounts for one provider are understandable and selectable.
- MCP, browser, memory, permissions, notifications and mission defaults have functional configuration
  surfaces rather than read-only placeholders.
- Authentication persists safely across refresh without storing sensitive tokens in local storage.
- Destructive actions require clear confirmation and explain their data impact.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## G3 — Device discovery, pairing and worker install

Provide a simple and safe path for Windows, Android, Linux/NAS and other supported workers.

Acceptance criteria:

- The dashboard creates a short-lived, single-use pairing ticket and QR code.
- Workers consume the existing pairing protocol rather than creating another one.
- Tailscale guidance is optional, explicit and does not expose tailnet-specific data.
- Installers never pass secrets on command lines and do not run as an overprivileged account.
- Device capabilities and local policies are visible and editable within allowed bounds.
- Pause, revoke, disconnect and prolonged-offline states are functional and tested.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## G4 — Desktop, mobile and voice completion

Turn existing shells into usable companions for mission monitoring and device actions.

Acceptance criteria:

- Desktop can launch or connect to a local NEXUS instance and exposes clear health diagnostics.
- Mobile can pair, receive mission updates, approve actions and revoke itself.
- The stale generated Android bundle is rebuilt reproducibly or removed from version control.
- Dictation uses the implemented local voice contract or clearly reports unavailable capability; no stub
  pretends to succeed.
- Offline and reconnection behavior does not duplicate user actions.

Implementation record:

- Status: `TODO`
- Started at:
- Completed at:
- Commit:
- Commands and results:
- Notes:

## G5 — Reproducible packaging and public user docs

Produce a public alpha installation path that a new user can follow without repository knowledge.

Acceptance criteria:

- Docker Compose provides the supported server baseline with persistent volumes and health checks.
- Linux/Arch and Windows packages have documented prerequisites and uninstall behavior.
- Kubernetes manifests remain optional and are clearly labeled with their current support level.
- Release artifacts are versioned; unsigned artifacts are labeled as such.
- The quick start contains no personal paths, accounts, hostnames or private topology.
- A blank-environment installation test exercises the documented instructions.

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

| Gate                  | Exact command                  | Result  | Evidence/date |
| --------------------- | ------------------------------ | ------- | ------------- |
| Dashboard format/lint | Record commands                | NOT RUN |               |
| Dashboard typecheck   | Record command                 | NOT RUN |               |
| Dashboard tests       | Record command and exact count | NOT RUN |               |
| Desktop compile       | Record command                 | NOT RUN |               |
| Mobile/Android checks | Record commands                | NOT RUN |               |
| Packaging smoke tests | Record commands                | NOT RUN |               |
| Blank install         | Record repository command      | NOT RUN |               |
| Release hygiene       | `pnpm release:check`           | NOT RUN |               |
| Translation gate      | `pnpm translation:check`       | NOT RUN |               |
