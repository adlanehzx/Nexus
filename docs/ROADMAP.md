# Roadmap

## Scheduling Principle

Every phase concludes with a **working, usable demonstration**, not merely a bundle of code. We
build in vertical slices: by the end of Phase 1, you can talk to the assistant directly from a
smartphone, even if backend components are still minimal.

Two fundamental rules govern sequencing:

1. **Permissions arrive alongside the very first tool, never after.** Retrofitting an authorization
   system onto an agent already performing actions is the most painful refactoring in the project —
   and in the interim, the agent could cause real damage.
2. **Protocols before clients.** WebSockets, contracts, and the durable execution loop are stabilized
   early, because five downstream consumers depend on them.

Durations assume **one person working part-time** and are indicative: order-of-magnitude guidelines
for sequencing, not rigid contractual commitments.

---

## Phase 0 — Foundations · ~1.5 weeks

**Objective** — A skeleton that compiles, passes tests, and deploys, before building any business
features.

- Monorepo pnpm + Turborepo, strict TypeScript, ESLint + boundary rules, Prettier.
- `@nexus/contracts`, `config`, `logger`, `errors`, `testing` (initial minimal versions).
- Prisma: initial schema (User, Session, Conversation, Message), migrations, seed scripts.
- Local Docker Compose (postgres + pgvector, redis, minio) + Dockerfiles.
- CI: install → typecheck → lint → test → build, gitleaks, `pnpm audit`.
- `/healthz`, structured logs, end-to-end `correlationId`.

**Exit Criteria** — `pnpm dev` boots all services; `pnpm test` passes cleanly; a test deployment runs
on a VPS and answers over HTTPS.

---

## Phase 1 — End-to-End Conversation · ~2 weeks

**Objective** — Chat with the assistant from a mobile phone with real-time streaming. No tools yet.

- Auth: signup, login, JWT + rotating refresh tokens, `expo-secure-store`.
- API v1: `/auth`, `/conversations`, `/messages`.
- `@nexus/llm`: `LLMProvider` port + one real provider adapter + `FakeLLM`.
- WS Gateway: typed envelopes, authentication, channels, heartbeat, reconnection, `seq` replay.
- `apps/worker` + BullMQ: minimal run execution (no tool loop), token streaming.
- Mobile Expo: conversation screen, composer, streaming display, history. Minimalist UI.

**Exit Criteria** — Sending "tell me a joke" from mobile displays the streamed answer in real time;
toggling airplane mode on and off seamlessly reconnects and resumes the stream without frame loss.

---

## Phase 2 — Agent, Tools, and Permissions · ~3 weeks · **Most Critical Phase**

**Objective** — The agent performs real-world actions, strictly under control.

- `@nexus/agent-core`: durable loop, `AgentRun` / `AgentStep`, token/step budgets, timeouts,
  cancellation, retries, partial results, replanning on failure.
- `tools-core`: `ToolDefinition`, `ToolRegistry`, `ToolExecutor` (validation, idempotency,
  timeouts, circuit breaker, redaction, artifacts).
- `permissions`: `RiskEvaluator`, `PermissionService`, scoped grants, deny-by-default posture.
- Confirmations: durable run suspension, `payloadHash`, single-use `nonce`, expiration, resumption.
- Initial tools: `search.web`, `weather.get`, `http.request`, `memory.*`, `calendar.*`, `mail.*`.
- Google OAuth (Calendar, Gmail) + encrypted credential vault.
- Mobile UI: tool execution cards, confirmation prompt cards, cancellation button.
- Comprehensive unit test suite covering loop transitions and the permission truth table.

**Exit Criteria** — "Check my unread emails and highlight important ones" functions reliably;
"Send an email to contact@example.com" renders a confirmation card displaying the exact drafted body;
rejecting the confirmation cancels cleanly; killing the worker mid-run and rebooting resumes smoothly.

---

## Phase 3 — Production Mobile Application · ~2.5 weeks

**Objective** — Transition from an initial prototype to a polished, everyday application.

- Design system (`@nexus/ui-tokens`), state animations (thinking / acting / awaiting input).
- Screens: History, Tasks, Permissions, Memory, Settings.
- Optimistic UI updates, offline handling, re-dispatch queues.
- Push notifications (confirmation prompts, run completions), actionable notifications.
- TestFlight builds, Sentry error tracking, crash telemetry.

**Exit Criteria** — The mobile application is used daily without opening a development terminal.

---

## Phase 4 — Device Agent · ~2.5 weeks

**Objective** — The assistant executes actions on a workstation triggered from mobile.

- `@nexus/device-protocol`, `/ws/device` gateway channel, Ed25519 pairing via QR code.
- Node daemon: local YAML policy, path sandboxing jail, shell command allowlist, command classifier.
- Tools: `device.fs.*`, `device.shell.exec`, `device.process.*`, `device.git.*`, `device.docker.*`.
- Heartbeats, auto-reconnection, task resumption, cancellation, stdout streaming.
- Windows Service installation script, binary signing.
- Desktop Devices UI: status dashboard, live log viewer, policy editor, emergency pause button.

**Exit Criteria** — "Open my project and run the test suite" from mobile streams test stdout live;
"Check why Docker is failing" returns diagnostic info; an unauthorized command outside local policy
is denied locally by the PC and clearly explained by the agent.

---

## Phase 5 — MCP and Browser Use · ~2.5 weeks

**Objective** — Extensibility via external tool servers and web automation.

- `McpManager`: stdio + HTTP/SSE, tool discovery, JSON Schema → Zod translation, supervision, hot
  reloading, isolated `mcp-runner` container. UI to register MCP servers.
- `apps/browser-worker`: FastAPI + browser-use, OpenAPI contract, cross-language TS ↔ Python contract tests.
- Tools: `browser.act` and `browser.navigate/extract/click/type`, live screenshot streaming.
- Network isolation, egress filtering, strict session execution budgets.

**Exit Criteria** — "Go to this site and extract pricing details" displays step-by-step navigation;
adding an external MCP server from the UI makes its tools available without redeployment, defaulting
to `CONFIRM`.

---

## Phase 6 — Long-Term Memory and Scheduled Tasks · ~2 weeks

**Objective** — The assistant remembers information across sessions and acts over time.

- pgvector + HNSW index, hybrid search with Reciprocal Rank Fusion, post-run extraction, deduplication,
  supersession tracking.
- Context compaction, `ConversationSummary`, `artifact.read`.
- Memory UI (browse, edit, pin, delete memories).
- Scheduled and recurring tasks ("Every morning, summarize my unread newsletters") via BullMQ repeatable jobs.
- Automated weekly garbage-collection job for outdated short-term memories.

**Exit Criteria** — The assistant recalls a specific preference stated three weeks prior; a 200-message
thread maintains stable context cost and latency; a morning scheduled task executes autonomously and
sends a digest notification.

---

## Phase 7 — Voice Interaction · ~2 weeks

**Objective** — Spoken input with voice synthesis responses.

- STT/TTS port interfaces + cloud adapters, dictation mode with editable on-device transcription.
- Audio streaming: `voice.chunk`, endpoint detection, sentence-by-sentence TTS, barge-in support.
- Voice configuration settings, "never persist raw audio" privacy mode, local adapters (whisper.cpp, Piper).

**Exit Criteria** — Hands-free voice conversation with under 1.5s perceived latency; any `CRITICAL`
action strictly refuses voice authorization and demands on-screen biometric confirmation.

---

## Phase 8 — Desktop App, Web Dashboard, and Hardening · ~3 weeks

**Objective** — Deliver a polished, observable, and hardened system.

- Tauri v2 app: shared React UI, system tray, global hotkeys, spotlight quick window, daemon supervisor.
- Web dashboard (Vite) for occasional browser access.
- Comprehensive observability: OpenTelemetry + Grafana/Loki/Tempo/Prometheus, cost dashboard, alerts.
- Run Inspector, full execution trace export, step replay.
- Agent evaluation suite (~50 scenarios) + nocturnal security prompt injection benchmarks.
- Security audit, full disaster recovery restoration drills, operational runbooks.

**Exit Criteria** — A failed run can be thoroughly diagnosed in under 5 minutes; nocturnal evaluation
suites pass cleanly; a complete blank-machine restoration drill is performed successfully.

---

## Overview Summary

| Phase                        | Duration  | Cumulative | Deliverable                  |
| ---------------------------- | --------- | ---------- | ---------------------------- |
| 0 · Foundations              | 1.5 wks   | 1.5        | deployable skeleton          |
| 1 · Conversation             | 2 wks     | 3.5        | **chat with assistant**      |
| 2 · Agent + Permissions      | 3 wks     | 6.5        | **acts, strictly governed**  |
| 3 · Mobile                   | 2.5 wks   | 9          | **daily mobile app**         |
| 4 · Devices                  | 2.5 wks   | 11.5       | **acts on workstation**      |
| 5 · MCP + Browser            | 2.5 wks   | 14         | **extensible web runner**    |
| 6 · Memory + Tasks           | 2 wks     | 16         | **remembers long term**      |
| 7 · Voice                    | 2 wks     | 18         | **spoken interaction**       |
| 8 · Desktop + Hardening      | 3 wks     | 21         | **reliable and observable**  |

≈ **5 months part-time**, with a useful working product available from week 6.5.

## Scope Reductions if Time is Constrained

In this priority order: Web dashboard (Phase 8), continuous streaming voice (keep dictation mode),
Tauri desktop GUI (mobile app + background daemon suffice), recurring tasks. **Never cut**:
permissions, confirmation gates, durable execution loop, audit logging. These guarantees ensure the
system remains safe to operate.
