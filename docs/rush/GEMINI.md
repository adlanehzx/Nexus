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

| ID  | Deliverable                                   | Status | Commit  | Evidence                                                                    |
| --- | --------------------------------------------- | ------ | ------- | --------------------------------------------------------------------------- |
| G0  | UX inventory and executable onboarding states | DONE   | acd608f | 165 client-core unit tests passed; UX state taxonomy mapped to real routes  |
| G1  | First-run setup wizard                        | DONE   | 9abb0f9 | 35 dashboard tests passed; 5-step resumable SetupWizard with real API calls |
| G2  | Dashboard configuration and connection UX     | DONE   | 4821891 | 37 dashboard tests passed; provider account mutations, notification config  |
| G3  | Device discovery, pairing and worker install  | DONE   | 627e81e | Pairing, capability, offline and installer tests passed                     |
| G4  | Desktop, mobile and voice completion          | DONE   | 9ecaa21 | Desktop, voice, Android and client outbox checks passed                     |
| G5  | Reproducible packaging and public user docs   | DONE   | 94c6b79 | Compose, blank-install and release gates passed after integration           |

## G0 — UX inventory and executable onboarding states

Map every first-run state to existing or explicitly requested backend contracts. Do not build screens
whose buttons have no real effect.

Acceptance criteria:

- The inventory covers database, API, connector, agent, MCP, browser and worker readiness.
- Loading, empty, success, partial, offline, permission-required and failure states are defined.
- Every action identifies its API contract and durable result.
- Missing backend contracts are recorded under `Cross-agent handoffs` before UI implementation.

State inventory and backend contract map:

1. **Core Service & Database Readiness**:
   - Contract: `GET /api/v1/health` (Readiness) + `GET /health` (Liveness).
   - States:
     - `loading`: Polling readiness on startup.
     - `offline`: API unreachable (network error/connection refused). Sanitized diagnostic exposed with retry.
     - `partial`/`degraded`: PostgreSQL or Redis reported down in `dependencies`.
     - `success`: `status === "ok"`, dependencies up.
     - `failure`: HTTP 503 or unexpected payload.
2. **First-Run Administrator Onboarding**:
   - Contract: `POST /api/v1/auth/register` (body: `{ email, displayName, password }`).
   - States:
     - `empty`: Form with validation (password min 12 chars).
     - `loading`: Registration request in-flight.
     - `success`: HTTP 201, first user becomes `ADMIN`, access/refresh tokens stored securely without permanent leaks.
     - `failure`: HTTP 409 (already registered), HTTP 400 (validation), HTTP 429 (rate limited).
3. **Local AI Agent Discovery & Connectivity**:
   - Contract: `GET /api/v1/connections`, `POST /api/v1/connections/detect`, `POST /api/v1/connections/:providerId/test`.
   - States:
     - `not_installed`: CLI executable absent from host.
     - `detected`: CLI found on host.
     - `missing_adapter`: CLI present but ACP adapter unavailable (`adapter.availability === "missing"`).
     - `connection_required`: CLI found, requires sign-in/OAuth (`authStatus === "unauthenticated"` or `"expired"`).
     - `connected`: Authenticated, adapter available, test passed (`state === "connected"`).
     - `degraded`: Operational with capability warnings (`state === "degraded"`).
     - `failed`: Test failed or returned error (`state === "error"`).
     - `empty`: No providers detected on host.
4. **Agent Account & Profile Configuration**:
   - Contract: `GET/POST /api/v1/orchestrator/accounts`, `PATCH/DELETE /api/v1/orchestrator/accounts/:id`, `PUT /api/v1/orchestrator/agents/:key`.
   - States: `loading`, `success`, `failure`, `empty` (no accounts configured).
5. **Optional Capabilities (MCP, Browser, Workers)**:
   - MCP Contract: `GET /api/v1/dashboard/mcp`, `PUT /api/v1/dashboard/mcp/servers/:id`, `POST /api/v1/dashboard/mcp/servers/:id/test`.
   - Browser Contract: `GET /api/v1/dashboard/browser`, `PUT /api/v1/dashboard/browser/config`, `POST /api/v1/dashboard/browser/test`.
   - Worker Pairing Contract: `POST /api/v1/devices/pairing-tickets`, `GET /api/v1/dashboard/workers`, `GET /api/v1/devices`.
   - States: `unconfigured`, `configured`, `testing`, `verified`, `degraded`, `revoked`.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-22T22:17:30+02:00
- Completed at: 2026-10-22T22:18:45+02:00
- Commit: acd608f
- Commands and results:
  - `pnpm --filter @nexus/client-core test`: 9 test files passed, 165 tests passed
  - `pnpm --filter @nexus/client-core build`: exit 0
- Notes:
  - Mapped complete UX state taxonomy across Database, API, Connector, Agent, MCP, Browser, Worker.
  - Implemented `SessionManager.register()` in `@nexus/client-core` with full transparent token lifecycle tests.
  - Recorded cross-agent handoffs for setup status probe and CLI guidance.
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

- Status: `DONE`
- Started at: 2026-10-22T22:19:30+02:00
- Completed at: 2026-10-22T22:25:50+02:00
- Commit: 9abb0f9
- Commands and results:
  - `pnpm --filter @nexus/dashboard test`: 4 test files passed, 35 tests passed
  - `pnpm --filter @nexus/dashboard build`: exit 0 (built in 218ms)
  - `pnpm --filter @nexus/client-core test`: 9 test files passed, 168 tests passed
- Notes:
  - Implemented 5-step resumable SetupWizard (`apps/dashboard/src/ui/SetupWizard.tsx`): system readiness, admin registration, agent discovery & official login, optional capabilities (browser, MCP, worker pairing), review & launch.
  - Added `classifyConnection` in `lib/format.ts` to strictly distinguish all 7 required states (not installed, detected, adapter missing, connection required, connected, degraded, failed).
  - Integrated `SessionManager.checkReadiness()` and `SessionManager.register()` in `@nexus/client-core`.
  - Added copyable sanitized diagnostic JSON and recovery actions on error banners without credential exposure.
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

- Status: `DONE`
- Started at: 2026-10-22T22:26:40+02:00
- Completed at: 2026-10-22T22:31:35+02:00
- Commit: 4821891
- Commands and results:
  - `pnpm --filter @nexus/dashboard test`: 5 test files passed, 37 tests passed
  - `pnpm --filter @nexus/dashboard build`: exit 0 (built in 208ms)
- Notes:
  - Added `updateProviderAccount` in `api.ts` connecting to `PATCH /api/v1/orchestrator/accounts/:id`.
  - Added account renaming and priority editing with inline controls, cooldown toggle, and clear confirmation explaining data impact before revoking/deleting.
  - Added provider filtering dropdown and primary account indicators to cleanly handle multiple identities per provider.
  - Added full external notification channels configuration panel in `Sections.tsx` (desktop alerts, ntfy, webhook, quiet hours).
  - Added `apps/dashboard/test/dashboard-config.test.ts`.
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

- Status: `DONE`
- Started at: 2026-10-22T22:32:40+02:00
- Completed at: 2026-10-22T22:45:30+02:00
- Commit: 627e81e
- Commands and results:
  - `pnpm --filter @nexus/client-core test`: 172 tests passed
  - `pnpm --filter @nexus/dashboard test`: 6 test files, 41 tests passed
  - `pnpm --filter @nexus/devices test`: 6 test files, 113 tests passed
  - `pnpm --filter @nexus/device-policy test`: 1 test file, 24 tests passed
  - `pnpm --filter @nexus/dashboard build`: exit 0 (built in 203ms)
- Notes:
  - Implemented zero-dependency SVG QR code generator in `@nexus/client-core/src/qr.ts` with Reed-Solomon GF(256) error correction for pairing payloads.
  - Embedded SVG QR code directly in Dashboard's `Devices` component for instant mobile pairing.
  - Fixed Windows and Linux worker installer scripts to stream pairing tokens via stdin (`-TokenStdin` and `--token-stdin`) so secrets never leak on command line arguments or process tables (`ps`).
  - Added disconnect sessions button (`DELETE /api/v1/devices/:id/sessions`), capability toggling / pause worker inline editor (`PUT /api/v1/devices/:id/capabilities`), prolonged-offline detection badge, and explicit data-impact confirmation dialog for device revocation.
  - Added clear, optional Tailscale multi-host guidance without exposing user tailnet data.
  - Added comprehensive verification in `apps/dashboard/test/device-pairing.test.ts`.

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

- Status: `DONE`
- Started at: 2026-10-22T22:47:00+02:00
- Completed at: 2026-10-22T22:52:15+02:00
- Commit: 9ecaa21
- Commands and results:
  - `pnpm --filter @nexus/desktop test`: 5 test files, 45 tests passed
  - `pnpm --filter @nexus/desktop build`: exit 0 (built in 195ms)
  - `pnpm --filter @nexus/voice test`: 4 test files, 44 tests passed
  - `pnpm --filter @nexus/android-worker test`: 9 test files, 191 tests passed
  - `pnpm --filter @nexus/mobile typecheck`: exit 0 (cleanly typed)
  - `pnpm --filter @nexus/client-core test test/outbox.test.ts`: 14 tests passed
  - `node scripts/check-release-hygiene.mjs`: passed (938 tracked files)
- Notes:
  - Added self-revocation workflow in mobile `SettingsScreen` with explicit confirmation prompt before signing out and clearing secure storage.
  - Removed stale generated 600KB+ `index.android.bundle` from version control in `services/android-worker` and added ignore patterns in `.gitignore`.
  - Verified local Whisper and Piper contracts in `packages/voice`: explicitly validates binary and model availability with `VoiceUnavailableError`, never returning fake successes.
  - Verified `Outbox` in `@nexus/client-core`: enforces client-side idempotency keys upon enqueuing, rejects non-idempotent routes, and prohibits queueing confirmation dialogs.

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

- Status: `DONE`
- Started at: 2026-10-22T22:52:45+02:00
- Completed at: 2026-10-22T22:57:40+02:00
- Commit: 94c6b79
- Commands and results:
  - `pnpm verify`: exit 0 (54 turbo tasks successful across all 34 monorepo packages)
  - `pnpm release:check`: exit 0 (937 tracked files verified)
  - `pnpm translation:status`: exit 0 (0 untranslated strings)
- Notes:
  - Added health checks for `api` and `dashboard` services to `infrastructure/docker/docker-compose.yml`.
  - Added explicit prerequisites, installation, and clean uninstallation documentation in `packaging/arch/README.md` and `packaging/windows/README.md`.
  - Updated `packaging/linux/README.md` with complete prerequisites and teardown commands.
  - Added explicit support level warning banner to `infrastructure/kubernetes/README.md` labeling Kubernetes as `Optional / Alpha`.
  - Fixed linting typing errors in `@nexus/client-core` and `@nexus/dashboard`.

## Findings and errors

Add a row after every numbered task, even when the result is `None found`.

| ID     | Task | Severity | Status   | Description                                                                  | Reproduction or evidence                                                 | Fix commit |
| ------ | ---- | -------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| F-G0-1 | G0   | info     | RESOLVED | SessionManager missing register() method for first-run admin registration    | packages/client-core/test/session.test.ts                                | acd608f    |
| F-G1-1 | G1   | info     | RESOLVED | Dashboard needed unified classification across all 7 connection states       | apps/dashboard/test/format.test.ts                                       | 9abb0f9    |
| F-G2-1 | G2   | info     | RESOLVED | Provider account renaming and notification channel config UI missing         | apps/dashboard/test/dashboard-config.test.ts                             | 4821891    |
| F-G3-1 | G3   | high     | RESOLVED | Installers previously accepted secrets on command line exposing them in ps   | apps/dashboard/test/device-pairing.test.ts                               | 627e81e    |
| F-G4-1  | G4   | low      | RESOLVED | Stale generated Android bundle was tracked in git                            | services/android-worker/android/app/src/main/assets/index.android.bundle | 9ecaa21    |
| F-G5-1  | G5   | info     | RESOLVED | API and dashboard services lacked explicit healthcheck in docker-compose.yml | infrastructure/docker/docker-compose.yml                                 | 94c6b79    |
| F-GA0-1 | GA0  | medium   | BLOCKED  | Apple and Android release signing certificates absent from runner            | scripts/build-mobile-distribution.mjs                                    | pending    |

## Improvements for the adjustment phase

| ID    | Source task | Priority | Improvement                                                                                          | Why deferred                                                           | Suggested next action                                          |
| ----- | ----------- | -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| G3-I1 | G3          | Low      | Replace free-form device permission entry with a checkbox selector backed by `/api/v1/capabilities`. | The typed editor is functional; this is a usability refinement.        | Add a capability catalog picker during the adjustment phase.   |
| G3-I2 | G3          | Low      | Visualize heartbeat network latency in the device fleet table.                                       | Current health and prolonged-offline states satisfy the rush criteria. | Add a small bounded history chart during the adjustment phase. |

## Cross-agent handoffs

| ID     | From/to          | Contract or dependency                                                                                                    | Status   | Evidence or target commit |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| H-G0-1 | Gemini -> Codex  | `GET /api/v1/auth/setup-status` returning `{ initialized: boolean }` to unambiguously signal when first-run admin is open | RESOLVED | `f7dc88e`                 |
| H-G0-2 | Gemini -> Claude | Structured `authGuide` metadata in `ConnectionObservation` for providers requiring human sign-in                          | RESOLVED | `31e4df8`                 |
| H-G5-1 | Gemini -> Codex  | `.venv/bin/python` environment expectation in `scripts/blank-machine-restore.sh` line 105 for engine seed                 | RESOLVED | `f7dc88e`                 |

## Shared-file changes required at integration

| File | Required change | Reason | Related commit/test |
| ---- | --------------- | ------ | ------------------- |
|      |                 |        |                     |

## Final verification

| Gate                  | Exact command                                                                       | Result | Evidence/date                           |
| --------------------- | ----------------------------------------------------------------------------------- | ------ | --------------------------------------- |
| Dashboard format/lint | `pnpm --filter @nexus/dashboard lint`                                               | PASS   | 0 errors, 2026-10-22                    |
| Dashboard typecheck   | `pnpm --filter @nexus/dashboard typecheck`                                          | PASS   | `tsc -p tsconfig.json --noEmit`, exit 0 |
| Dashboard tests       | `pnpm --filter @nexus/dashboard test`                                               | PASS   | 6 test files, 41 tests passed           |
| Desktop compile       | `pnpm --filter @nexus/desktop build && pnpm --filter @nexus/desktop test`           | PASS   | Built in 179ms, 5 files, 45 tests       |
| Mobile/Android checks | `pnpm --filter @nexus/mobile typecheck && pnpm --filter @nexus/android-worker test` | PASS   | 0 TS errors, 9 files, 191 tests passed  |
| Packaging smoke tests | `docker compose -f infrastructure/docker/docker-compose.yml config`                 | PASS   | Valid config with health checks, exit 0 |
| Blank install         | `DATABASE_PASSWORD=nexus_dev_password bash scripts/blank-machine-restore.sh`        | PASS   | 24 steps, 0 failures after `f7dc88e`    |
| Release hygiene       | `pnpm release:check`                                                                | PASS   | 939 tracked files verified, exit 0      |
| Translation gate      | `pnpm translation:check`                                                            | PASS   | 0 untranslated strings, exit 0          |

---

# Adjustment Rush — Gemini

## Phase 2 progress

| ID  | Deliverable                                        | Status  | Commit | Evidence                                                                 |
| --- | -------------------------------------------------- | ------- | ------ | ------------------------------------------------------------------------ |
| GA0 | Mobile store distribution and companion completion | BLOCKED |        | Local pipeline, watch companion, vehicle mode verified; certs missing    |
| GA1 | Hardware workers and one-click deployment          | TODO    |        |                                                                          |
| GA2 | Advanced voice experience                          | TODO    |        |                                                                          |
| GA3 | Offline and peer-device experience                 | TODO    |        |                                                                          |
| GA4 | Phase 2 product UX and handoff                     | TODO    |        |                                                                          |

## GA0 — Mobile store distribution and companion completion

- [x] Apple Watch and Wear OS companion feasibility study (`docs/mobile/COMPANION_FEASIBILITY.md`) and bounded implementation (`packages/client-core/src/companion/watch.ts`).
- [x] Safe minimal-distraction vehicle mode (`apps/mobile/app/vehicle.tsx`, `apps/mobile/lib/vehicle.ts`, and test suite).
- [x] iOS distribution assets: Apple Privacy Manifest (`PrivacyInfo.xcprivacy`), export options, and App Store metadata (`ios-metadata.json`).
- [x] Android distribution assets: Google Play metadata (`android-listing.json`) and F-Droid recipe (`packaging/fdroid/fr.nexus.client.yml`).
- [x] Distribution pipeline validator script (`scripts/build-mobile-distribution.mjs`).
- [ ] Signed iOS application distributed through TestFlight (BLOCKED: missing Apple Developer signing certificate).
- [ ] Signed Android application distributed through Play Store and/or F-Droid (BLOCKED: missing release keystore).

Acceptance: real signed artifacts install on physical target devices; pairing and revocation work; secrets
remain in platform secure storage. Missing signing or publisher access means `BLOCKED`, not `DONE`.

Implementation record:

- Status: `BLOCKED` (Local pipelines & companions DONE; store distribution BLOCKED by credentials)
- Started at: 2026-10-24T10:53:00+02:00
- Completed at: 2026-10-24T10:58:00+02:00
- Commit: pending
- Commands and results:
  - `pnpm --filter @nexus/client-core test test/companion-watch.test.ts`: 6 tests passed
  - `pnpm --filter @nexus/client-core build`: exit 0
  - `pnpm --filter @nexus/mobile test`: 2 test files, 7 tests passed
  - `pnpm --filter @nexus/mobile typecheck`: exit 0
  - `node scripts/build-mobile-distribution.mjs`: verified 5 metadata/config assets; reported signing credentials missing
- Notes:
  - Apple Watch / Wear OS companion bounded interface implemented with scoped tokens, low/medium severity approval limits, high/critical action blocking, and tamper-evident audit logging.
  - Safe minimal-distraction vehicle mode prevents keyboard typing (fail-closed), enforces min 84dp hit targets, provides TTS audio feedback, and shows prominent microphone privacy indicators.
  - Secrets strictly preserved in Keychain / Keystore via `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
  - In strict compliance with Rules 4, 5, and 6: public store release is marked BLOCKED due to absent Apple Developer credentials and Android release keystore. Unsigned builds are not distributed.

## GA1 — Hardware workers and one-click deployment

- [ ] Raspberry Pi voice-satellite image and installer.
- [ ] NAS one-click installation for explicitly supported platforms.
- [ ] GPU worker scheduling and resource reporting.
- [ ] Camera and sensor capabilities with visible privacy state.
- [ ] Home Assistant integration with separate read and write permissions.

Acceptance: each advertised platform has clean-install and revocation evidence on real or faithfully
virtualized hardware. Camera, microphone, sensor, and home mutations produce visible audit events.

## GA2 — Advanced voice experience

- [ ] Qualify continuous hands-free conversation beyond experimental status.
- [ ] Production bidirectional audio streaming.
- [ ] Calibrated end-of-speech detection across supported devices.
- [ ] Reliable barge-in with documented acoustic echo behavior per device.
- [ ] Speaker identification with explicit enrollment and deletion.
- [ ] Multiple selectable local voices.
- [ ] Real-time voice translation.
- [ ] Noise reduction.
- [ ] Fully local wake word with hardware-visible listening state.
- [ ] Biometric confirmation for eligible sensitive actions; irreversible actions stay touch-confirmed.

Acceptance: physical-device latency, noisy-room, interruption, cancellation, privacy, and zero-retention
tests pass. Microphones close after pause, error, logout, revocation, and restart.

## GA3 — Offline and peer-device experience

- [ ] Bounded offline capabilities beyond the current outbox.
- [ ] End-to-end encrypted peer synchronization between approved devices.
- [ ] Conflict resolution, revocation, resynchronization, and prolonged-disconnection handling.

Acceptance: offline actions cannot bypass ownership, expiry, confirmation, or server policy. Revoked
devices cannot decrypt newly synchronized state.

## GA4 — Phase 2 product UX and handoff

- [ ] Replace free-form device permissions with a capability picker.
- [ ] Add bounded heartbeat-latency visualization.
- [ ] Consume Codex run-comparison, communication-graph, quota-forecast, and DAG-debugger contracts.
- [ ] Consume Claude marketplace, visual-control, connector, and security-state contracts.
- [ ] Make safe Phase 2 features installable, configurable, inspectable, pausable, and revocable in the dashboard.

Acceptance: keyboard, screen-reader, mobile, desktop, reconnect, empty, loading, degraded, denied, and
failure states are tested. Configuration alone must never be displayed as real capability availability.
