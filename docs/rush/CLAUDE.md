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
| CL0 | Baseline connection and threat-model fixtures    | DONE   | acc5968 | 290 focused tests passing across connections and connector packages           |
| CL1 | Truthful CLI, adapter and session detection      | DONE   | 31e4df8 | 218 tests passing in @nexus/connections including adapter and authGuide tests |
| CL2 | Secure ACP connector and multi-account contracts | DONE   | 84d115d | 146 connector tests passing + 9 provider-accounts tests passing               |
| CL3 | MCP catalog, OAuth and per-server isolation      | DONE   | 4dbfd5c | 62 tests passing in @nexus/mcp across 7 test files                            |
| CL4 | Browser sessions, permissions and audit          | DONE   | 5f34cbe | 31 browser-client tests + 76 browser-worker pytest + 51 host tests passing    |
| CL5 | Contract tests and integration handoff           | DONE   | c3cedf9 | Complete API contracts + deterministic streamed ACP fake contract tests       |

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

- Status: `DONE`
- Started at: 2026-10-23T15:47:00+02:00
- Completed at: 2026-10-23T16:01:00+02:00
- Commit: 84d115db011ca14838fa61a2938e55e003468593
- Commands and results:
  - `pnpm --filter @nexus/connector build`: succeeded.
  - `pnpm --filter @nexus/connector test`: 9 test files, 146 passed.
  - `pnpm --filter @nexus/connector format:check && pnpm --filter @nexus/connector lint`: succeeded.
  - `pnpm --filter @nexus/api test test/provider-accounts.test.ts`: 9 passed.
- Notes:
  - Implemented real CLI daemon entrypoint (`nexus-connector`) with state directory (mode 0700) and durable nonce logging via `FileNoncePersistence`.
  - Added signed `ConnectorHttpClient` communicating over Unix domain sockets or loopback TCP with request canonicalization and Ed25519 signatures.
  - Hardened Unix socket creation with restrictive umask (0o077) and owner-only 0600 chmod to eliminate access race conditions.
  - Windows explicitly rejected for Unix socket transport and CLI daemon until a safe transport without shell invocation is verified.
  - Enforced key rotation and revocation primitives in `admin.ts`.
  - Updated `provider-accounts.ts` with typed disabling (`enabled: boolean`), filtering disabled identities from `selectAccount`, and ensuring `probeAuth` never promotes an unproven account without evidence.

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

- Status: `DONE`
- Started at: 2026-10-23T16:02:00+02:00
- Completed at: 2026-10-23T16:18:00+02:00
- Commit: 4dbfd5c
- Commands and results:
  - `pnpm --filter @nexus/mcp build`: success.
  - `pnpm --filter @nexus/mcp typecheck`: success.
  - `pnpm --filter @nexus/mcp lint`: success.
  - `pnpm --filter @nexus/mcp test`: 7 test files, 62 tests passed.
- Notes:
  - Defined strict third-party MCP manifest schema (`mcpManifestSchema`) with runtimes limited to `npm` and `remote`.
  - Added curated verified catalog (`MCP_CATALOG`) and structured installation compiler (`compileManifestToServerConfig`).
  - Added OAuth 2.0 PKCE with S256 challenge, anti-replay single-use state store, and vault token storage.
  - Hardened remote MCP client transport with SSRF validation (`assertSafeRemoteUrl`) blocking loopback, RFC 1918, link-local metadata (169.254.169.254), IPv6 private/multicast, and DNS rebinding.
  - Implemented real host sandbox capabilities probing (`probeHostSandboxCapabilities`) and systemd cgroups v2 resource limit scoping (`systemd-run --user --scope -pMemoryMax=... -pTasksMax=... -pCPUQuota=...`) with fail-closed guarantee when strict limits are demanded.
  - Bounded tool output length (`boundOutputText`) and guaranteed secrets are injected only into target process environment, never into command args, URLs or logs.

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

- Status: `DONE`
- Started at: 2026-10-23T16:19:00+02:00
- Completed at: 2026-10-23T16:26:00+02:00
- Commit: 5f34cbe
- Commands and results:
  - `pnpm --filter @nexus/browser-client build`: success.
  - `pnpm --filter @nexus/browser-client typecheck`: success.
  - `pnpm --filter @nexus/browser-client lint`: success.
  - `pnpm --filter @nexus/browser-client test`: 2 passed, 1 skipped (31 tests passed).
  - `uv run --project services/browser-worker --extra dev pytest services/browser-worker/tests`: 76 passed.
  - `pnpm --filter @nexus/browser-worker-host test`: 3 passed, 1 skipped (51 tests passed).
- Notes:
  - Added explicit session ownership (`ownerId`), lifetime checks, and cancellation (`cancelSession`) in `BrowserSessionManager`, preventing cross-user session leakage.
  - Hardened SSRF defense in `BrowserSecurityPolicy`: rejects loopback, RFC 1918, link-local metadata (169.254.169.254, metadata.google.internal), carrier-grade NAT, IPv6 link-local/multicast/mapped, and decimal/hex/octal IP formats.
  - Added asynchronous DNS resolution check (`assertSafeNavigation`) against DNS rebinding.
  - Added scoped permissions assertion (`assertScopedPermission`) for download, upload, clipboard, credentials (`browser.login`), and persistent profile.

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

- Status: `DONE`
- Started at: 2026-10-23T16:27:00+02:00
- Completed at: 2026-10-23T16:36:00+02:00
- Commit: c3cedf9
- Commands and results:
  - `pnpm --filter @nexus/api test test/connections.test.ts test/provider-accounts.test.ts`: 12 tests passed.
  - `pnpm --filter @nexus/agent test`: 4 tests passed (including `test/acp-runner.test.ts`).
- Notes:
  - Added typed API contracts for `POST /connections/:providerId/connect` and `POST /connections/:providerId/disconnect` matching `ConnectionCatalogService` and `LocalConnectionManager`.
  - Added deterministic fake ACP provider contract tests (`services/agent/test/acp-runner.test.ts`) streaming answer chunks, validating in-workspace permission handling, out-of-workspace rejection, and sanitized error mapping.

## Findings and errors

Add a row after every numbered task, even when the result is `None found`.

| ID    | Task | Severity | Status   | Description                                                                                                    | Reproduction or evidence                                                                                | Fix commit                |
| ----- | ---- | -------- | -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------- |
| CL0-1 | CL0  | Info     | RESOLVED | Worktree package dist artifacts missing on initial checkout, requiring initial workspace build.                | Vitest failed resolving `@nexus/shared` until `pnpm build` was run across dependencies.                 | Resolved by initial build |
| CL1-1 | CL1  | Low      | RESOLVED | Version manager shims (mise) stalled detection under strict minimal env allowlist.                             | Detection probes timed out in 10s for shims requiring ambient mise variables.                           | 77841a8                   |
| CL2-1 | CL2  | Medium   | RESOLVED | Insecure umask during Unix socket creation and unproven promotion in probeAuth.                                | Socket created before chmod with ambient umask; probeAuth promoted unknown accounts.                    | 84d115d                   |
| CL3-1 | CL3  | Medium   | RESOLVED | Missing SSRF check on remote MCP URLs and unbounded tool output length.                                        | Remote URLs previously connected without IP checks; tool output wasn't bounded.                         | 4dbfd5c                   |
| CL4-1 | CL4  | Medium   | RESOLVED | Missing IPv6 mapped loopback and session ownership checks in browser client.                                   | `[::ffff:127.0.0.1]` and sessions without owner validation allowed potential pivot.                     | 5f34cbe                   |
| CL5-1 | CL5  | Info     | RESOLVED | Missing connect/disconnect endpoints in API connection routes and lack of deterministic ACP runner unit suite. | API lacked POST /connections/:providerId/connect & disconnect routes matching ConnectionCatalogService. | c3cedf9                   |

## Improvements for the adjustment phase

| ID  | Source task | Priority | Improvement | Why deferred | Suggested next action |
| --- | ----------- | -------- | ----------- | ------------ | --------------------- |
|     |             |          |             |              |                       |

## Cross-agent handoffs

| ID    | From/to          | Contract or dependency                                                                     | Status   | Evidence or target commit |
| ----- | ---------------- | ------------------------------------------------------------------------------------------ | -------- | ------------------------- |
| C5-H3 | Gemini to Claude | Add structured, secret-free `authGuide` metadata to connection observations (also H-G0-2). | RESOLVED | 31e4df8                   |

## Shared-file changes required at integration

| File                                              | Required change                                                                                                               | Reason                                                                                                                               | Related commit/test                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `services/api/src/routes/v1/connections.ts`       | Added `POST /connections/:providerId/connect` and `POST /connections/:providerId/disconnect` routes                           | Expose connect and disconnect operations in HTTP API matching `ConnectionCatalogService` contract                                    | `c3cedf9` / `test/connections.test.ts`       |
| `services/api/src/services/connection-manager.ts` | Added `connect(providerId)` and `disconnect(providerId)` to `ConnectionCatalogService` interface and `LocalConnectionManager` | Allow direct lifecycle state transitions via connection manager                                                                      | `c3cedf9` / `test/connections.test.ts`       |
| `services/api/src/services/provider-accounts.ts`  | Added `enabled` property to `ProviderAccount` and typed `enableProviderAccount` / `disableProviderAccount` functions          | Support typed account enable/disable states                                                                                          | `bfa69c8` / `test/provider-accounts.test.ts` |
| `services/agent/test/acp-runner.test.ts`          | Added deterministic ACP runner contract test using `services/agent/scripts/e2e-acp-agent.mjs`                                 | Validate real streamed answer chunks, in-workspace permissions, out-of-workspace rejection, and error mapping without external quota | `c3cedf9`                                    |

## Final verification

| Gate               | Exact command                                                                                                                                                                                                                                                                                                                            | Result | Evidence/date                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections format | `pnpm --filter @nexus/connections format:check`                                                                                                                                                                                                                                                                                          | PASSED | Clean prettier check across all files / 2026-10-23                                                                                            |
| Connector format   | `pnpm --filter @nexus/connector format:check`                                                                                                                                                                                                                                                                                            | PASSED | Clean prettier check across all files / 2026-10-23                                                                                            |
| Focused lint       | `pnpm --filter @nexus/connections --filter @nexus/connector --filter @nexus/mcp --filter @nexus/browser-client --filter @nexus/api --filter @nexus/agent lint`                                                                                                                                                                           | PASSED | 6 workspace projects clean / 2026-10-23                                                                                                       |
| Focused typecheck  | `pnpm --filter @nexus/connections --filter @nexus/connector --filter @nexus/mcp --filter @nexus/browser-client --filter @nexus/api --filter @nexus/agent typecheck`                                                                                                                                                                      | PASSED | 6 workspace projects clean / 2026-10-23                                                                                                       |
| Focused build      | `pnpm --filter @nexus/connections --filter @nexus/connector --filter @nexus/mcp --filter @nexus/browser-client --filter @nexus/api --filter @nexus/agent build`                                                                                                                                                                          | PASSED | 6 workspace projects built successfully / 2026-10-23                                                                                          |
| Focused tests      | `pnpm --filter @nexus/connections test && pnpm --filter @nexus/connector test && pnpm --filter @nexus/mcp test && pnpm --filter @nexus/browser-client test && pnpm --filter @nexus/api test test/connections.test.ts test/provider-accounts.test.ts && pnpm --filter @nexus/agent test && pnpm --filter @nexus/browser-worker-host test` | PASSED | 600 tests passed (218 connections, 146 connector, 62 mcp, 31 browser-client, 12 api, 4 agent, 51 browser-worker-host, 76 pytest) / 2026-10-23 |
| Browser worker     | `uv run --project services/browser-worker --extra dev pytest services/browser-worker/tests`                                                                                                                                                                                                                                              | PASSED | 76 passed, 2 deselected, 1 warning in 2.53s / 2026-10-23                                                                                      |
| Release hygiene    | `pnpm release:check`                                                                                                                                                                                                                                                                                                                     | PASSED | 962 tracked files clean / 2026-10-23                                                                                                          |
| Translation gate   | `pnpm translation:check`                                                                                                                                                                                                                                                                                                                 | PASSED | English only check passed, clean / 2026-10-23                                                                                                 |

---

# Adjustment Rush — Claude/Antigravity

## Phase 2 progress

| ID   | Deliverable                                   | Status | Commit | Evidence |
| ---- | --------------------------------------------- | ------ | ------ | -------- |
| CLA0 | Public catalogs and marketplace trust         | DONE   | 487b141 | 78 tests passing in @nexus/mcp (16 new marketplace tests) |
| CLA1 | Visual navigation and native-computer control | DONE   | e593a28 | 43 browser-client tests (12 new visual tests) + 76 pytest |
| CLA2 | External automation ecosystem                 | TODO   |        |          |
| CLA3 | Advanced execution security                   | TODO   |        |          |
| CLA4 | Third-party plugin lifecycle                  | TODO   |        |          |
| CLA5 | Security and tool-plane handoff               | TODO   |        |          |

## CLA0 — Public catalogs and marketplace trust

- [x] Public ACP-agent marketplace.
- [x] Public MCP-server marketplace.
- [x] Worker catalog.
- [x] Versioned workflow catalog.
- [x] Ratings, reviews, and abuse-resistant reputation.
- [x] Publisher verification.
- [x] Automated static and behavioral package analysis.
- [x] Mandatory package signatures and provenance attestations.
- [x] One-click community installation with permission preview.
- [x] Compromise advisories, revocation, quarantine, and rollback.

Acceptance: untrusted components cannot bypass provenance, sandboxing, permissions, resource ceilings,
secret scoping, or revocation. The curated local catalog remains available offline.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-24T10:51:00+02:00
- Completed at: 2026-10-24T10:56:00+02:00
- Commit: 487b141
- Commands and results:
  - `pnpm prettier --check packages/mcp`: passed cleanly.
  - `pnpm --filter @nexus/mcp lint`: 0 errors.
  - `pnpm --filter @nexus/mcp typecheck`: 0 errors.
  - `pnpm --filter @nexus/mcp build`: succeeded.
  - `pnpm --filter @nexus/mcp test`: 8 test files, 78 passed.
- Notes:
  - Built marketplace subsystem in `@nexus/mcp/marketplace` supporting MCP servers, ACP agents, workers, and workflows.
  - Implemented Ed25519 digital signatures and SHA-256 canonical JSON attestation hashing in `signatures.ts`.
  - Added automated static and behavioral package analyzer (`analysis.ts`) detecting shell injection risks, sensitive path traversals, loopback/metadata SSRF egress, dynamic eval/Function, and unconfirmed critical tools.
  - Implemented Bayesian weighted reputation with Sybil resistance (requiring verified installation proof) and auto-quarantine upon abuse report threshold in `reputation.ts`.
  - Added compromise advisories, quarantine, version-specific revocation CRL, and atomic version rollback in `advisories.ts`.
  - Ensured curated local catalog (`MCP_CATALOG`) remains immediately available offline.


## CLA1 — Visual navigation and native-computer control

- [x] Optional OmniParser behind a model-independent visual parser port.
- [x] Screenshot-grounded navigation with bounded image retention.
- [x] Expanded native-application control through device workers.
- [x] Secure owned and expiring remote-desktop sessions.
- [x] General UI recognition with confidence reporting.
- [x] Multi-screen targeting and audit.
- [x] Secret-safe recording and replay of user demonstrations.
- [x] Convert demonstrations into reviewable permission-scoped plans, never opaque code.

Acceptance: tests cover prompt injection, malicious pixels, stale screenshots, coordinate drift, and
cross-session ownership. Destructive native actions require confirmation.

Implementation record:

- Status: `DONE`
- Started at: 2026-10-24T10:57:00+02:00
- Completed at: 2026-10-24T11:01:00+02:00
- Commit: e593a28
- Commands and results:
  - `pnpm prettier --check packages/browser-client`: passed cleanly.
  - `pnpm --filter @nexus/browser-client build`: succeeded.
  - `pnpm --filter @nexus/browser-client typecheck`: 0 errors.
  - `pnpm --filter @nexus/browser-client lint`: 0 errors.
  - `pnpm --filter @nexus/browser-client test`: 4 test files, 43 passed (12 new visual computer control tests).
  - `uv run --project services/browser-worker --extra dev pytest services/browser-worker/tests`: 76 passed.
- Notes:
  - Designed `VisualParserPort` with interchangeable `OmniParserEngine` (optional, fails closed if unconfigured) and built-in offline `HeuristicVisualParserEngine`.
  - Added `RemoteDesktopSessionManager` with strict ownership binding (`ownerId`), expiring bearer tokens, immediate revocation, and immutable audit logging.
  - Added `MultiScreenManager` for targeting displays with bounds verification and DPI scale factor normalization against coordinate drift.
  - Added `VisualSecurityGuard` protecting against OCR prompt injection, stale screenshot replay via SHA-256 fingerprinting and TTL, and enforced human confirmation for destructive native actions.
  - Added `DemonstrationPlanCompiler` recording user demonstrations with secret/password redaction, compiling into human-reviewable, permissioned Markdown execution plans rather than opaque code.


## CLA2 — External automation ecosystem

- [ ] n8n alternative to Activepieces.
- [ ] Typed Slack, Discord, Teams, Telegram, and Notion tools.
- [ ] Linear, Jira, and Trello connectors.
- [ ] Google Drive, Dropbox, and OneDrive connectors.
- [ ] Signed, replay-protected external event triggers and webhooks.
- [ ] Shared, versioned, exportable workflows.

Acceptance: read and write scopes are distinct; webhook verification and anti-replay are mandatory; all
external mutations follow preview and confirmation policy.

## CLA3 — Advanced execution security

- [ ] Independent external-audit scope and reproducible evidence bundle.
- [ ] Continuous fuzzing of public parsers, protocols, manifests, and archives.
- [ ] Agent behavioral anomaly detection.
- [ ] Exfiltration detection across prompts, tools, network, logs, and artifacts.
- [ ] TPM and Secure Enclave vault ports.
- [ ] Worker remote attestation.
- [ ] Firecracker or equivalent microVM tier.
- [ ] Dynamic per-task network policies.
- [ ] Mandatory signatures for release and marketplace components.
- [ ] Reproducible-build verification on supported release targets.
- [ ] Privacy-preserving public vulnerability intake automation.

Acceptance: optional security facilities fail closed when absent. Existing bubblewrap/container isolation
remains supported and is never silently downgraded.

## CLA4 — Third-party plugin lifecycle

- [ ] Plugin API without arbitrary host-code execution.
- [ ] Permission, provenance, update, rollback, disable, and revoke lifecycle.
- [ ] Advisory public reputation that can never override local security policy.

Acceptance: malicious fixtures cannot access host credentials, unrelated files, metadata endpoints, other
tenants, other plugin secrets, or undeclared tools.

## CLA5 — Security and tool-plane handoff

Run focused and repository-wide gates, then provide Codex and Gemini with typed contracts, migrations,
threat models, SBOM, signature, revocation, and rollback evidence. Platform limitations remain `BLOCKED`.
