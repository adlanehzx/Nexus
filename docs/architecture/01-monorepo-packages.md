# 01 — Monorepo & packages

## 1. Layout

This is the tree as it exists. An earlier revision of this document described a planned layout
with different names — `apps/api`, `packages/contracts`, `packages/tools-core` — and some ADRs
still use them. The mapping is: `apps/api` → `services/api`, `apps/worker` → folded into
`services/api` and `services/mission-engine`, `packages/contracts` → `packages/protocol`,
`packages/tools-core` → `packages/tools`, `packages/errors` + `packages/logger` →
`packages/shared`.

```
nexus/
├── apps/
│   ├── mobile/              Expo / React Native
│   ├── desktop/             Tauri v2 + React — Windows, macOS, Linux
│   ├── dashboard/           Vite + React, administration, ADMIN role
│   └── web/                 Vite + React
├── services/
│   ├── api/                 Fastify — REST v1, WebSocket, auth, composition root
│   ├── agent/               NEXUS native ACP runtime
│   ├── mission-engine/      Python / FastAPI — durable mission DAG, SQLite WAL
│   ├── browser-worker/      Python / FastAPI / browser-use. Outside the TS pipeline
│   ├── windows-worker/      Windows executor daemon
│   └── android-worker/      Android executor (React Native + Kotlin)
├── packages/
│   ├── shared/              Error taxonomy, UUID v7, redaction, version comparison
│   ├── config/              Environment loading and validation (Zod). No literal secret
│   ├── protocol/            Zod: API DTOs, WS protocol, tool schemas. Source of truth
│   ├── database/            Prisma schema + client + stores
│   ├── auth/                Tokens, passwords, mission grants, service identities
│   ├── agent-core/          Loop, planner, budgets, resumption policies
│   ├── tools/               ToolDefinition, ToolRegistry, ToolExecutor, permissions
│   ├── llm/                 LLMProvider + adapters (CLI agents, local)
│   ├── memory/              Context assembly, compaction, retrieval
│   ├── mcp/                 MCP server management → ToolRegistry adapter
│   ├── browser-client/      Typed Browser Worker client (HTTP + events)
│   ├── mission-control-client/ Typed Mission Engine client
│   ├── devices/             Registry, selector, tasks, pairing, update advice
│   ├── device-policy/       Local device policy with verifiable refusals
│   ├── worker-core/         Runtime shared by executors. Runs on Hermes too
│   ├── client-core/         Client core: session, realtime, state, offline, crash
│   ├── voice/               Local dictation and speech — whisper.cpp, Piper
│   ├── notifications/       External notification dispatch
│   ├── web-search/          Local SearXNG client and network policy
│   ├── google-workspace/    Gmail and Calendar integration
│   ├── documents/           Multi-format document parsing (Docling, PDF, OCR)
│   ├── activepieces/        Local SaaS automation bridge
│   └── cli/                 The `nexus` command
├── evals/
│   └── security/            Adversarial corpus: the model is assumed compromised
├── mcp/                     MCP configuration presets (github, filesystem)
├── infrastructure/
│   ├── docker/              Dockerfiles, compose, observability stack
│   ├── kubernetes/          Manifests
│   └── systemd/             User units
├── packaging/               Arch PKGBUILD, Windows installer and service
├── docs/
├── turbo.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 2. Dependency rules (enforced in CI)

The graph is **acyclic and points downwards**. Breaking a rule breaks the build.

```
apps/*, services/*  ──────► packages/*                          allowed
packages/agent-core ──────► llm, tools, memory, protocol, shared
packages/agent-core ──────╳ database, mcp, browser-client       FORBIDDEN
packages/tools      ──────╳ llm                                 FORBIDDEN
packages/*          ──────╳ apps/*, services/*                  FORBIDDEN
```

Three prohibitions deserve their justification:

- **`agent-core` does not depend on `database`.** The loop receives an `AgentRunStore` port; the
  Prisma implementation lives in `services/api`. That is what makes the loop testable without a
  database and replayable over an in-memory state.
- **`agent-core` knows nothing about concrete tools.** It only sees `ToolDefinition`s. Adding an
  MCP server never touches the agent core.
- **`tools` does not depend on `llm`.** A tool is not an LLM concept; it is a capability described
  by a schema. Formatting it into a provider's tool-calling format is the LLM adapter's job.

A fourth rule is specific to one package: **`worker-core` imports no `node:` API**, because it also
runs on Hermes, the JavaScript engine on Android. A single such import would break the Android
bundle, and the error would only appear on the phone — the worst possible place to find it. A test
in that package enforces it, and it has already refused a change that would have broken it.

## 3. `@nexus/protocol`: the keystone

One place defines every data shape that crosses a network boundary, in Zod:

```ts
export const ToolCallSchema = z.object({ id, name, args: z.unknown() });
export const WsServerEvent = z.discriminatedUnion("type", [
  AgentTokenEvent,
  ToolStartedEvent,
  ConfirmationRequestedEvent /* ... */,
]);
export type WsServerEvent = z.infer<typeof WsServerEvent>;
```

The benefit: mobile, desktop, the API, the engine and the device agents share **the same types and
the same runtime validation**. Protocol versioning happens here, through a `v` field in every
envelope.

The Python workers cannot import Zod, so a JSON Schema is generated for them from the same
definitions, and a contract test checks that both sides agree. It runs on both sides in CI: a
divergence breaks the build rather than production (→ [15-testing](15-testing.md)).

## 4. Build & CI

- **Turborepo**: `build → typecheck → lint → test` with a local cache. The Python services are
  opaque tasks (`uv` + `pytest`) hanging off the same graph.

  One caveat learned the hard way: a task's `inputs` must list every file its tests actually read.
  A guard test checking the Gradle files for signing secrets could not fail, because those files
  were not declared — the cache answered "green" for a file that had just changed. A test whose
  inputs are undeclared is a test that can no longer fail, and it fails silently.

- **TypeScript**: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`.
- **pnpm**: `node-linker=isolated`, so a package must declare what it imports. A phantom
  dependency fails at install time rather than in production.
