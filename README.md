# NEXUS

A multi-device personal AI assistant — iPhone, PC, web — able to carry out real actions: send an
email, run a project's tests, drive a browser, operate your own machines.

> **Status: working local alpha.** The core, the durable Mission Engine, the ACP agents,
> authentication, the dashboard, permissions, vector memory and observability are integrated and
> tested. Distributed clients, public packaging and some external integrations remain
> experimental: see [docs/ROADMAP.md](docs/ROADMAP.md).

**The guiding principle** — the model can do nothing except emit text and _ask_ for a tool to run.
Every real capability goes through the tool registry, is filtered by the permission service,
executed by the executor, and traced. There is no alternative path between a model and the outside
world.

**It runs on your machines.** No account, no hosted service, no paid API key: reasoning comes from
ACP agents you already have, dictation and speech synthesis run locally through whisper.cpp and
Piper, and web search goes through a local SearXNG. NEXUS talks to your machines and to nothing
else.

---

## What this is, and what it is not

It helps to be blunt about both, because the second list is what makes the first one safe.

**It is** a personal assistant that executes. It holds device private keys, runs shell commands on
machines you have paired, reads and writes files inside roots you have declared, and asks you
before anything irreversible.

**It is not** a hosted product, a chatbot, or something you should expose to the internet. There
is no multi-tenancy: one installation serves one person. There is no path that lets the core push
code to one of your machines — that absence is deliberate and tested, because such a path would be
remote code execution by design, and it would void every other guarantee below.

Before trusting it with anything, read **[SECURITY.md](SECURITY.md)**: four trust boundaries,
each enforced in code and covered by adversarial tests.

## 1. Requirements

| Tool             | Version                     | Check                    |
| ---------------- | --------------------------- | ------------------------ |
| Node.js          | **24.20.0** (LTS "Krypton") | `node -v`                |
| pnpm             | **11.25.0**                 | `pnpm -v`                |
| Docker + Compose | 27+ / v2                    | `docker compose version` |

The repository contains an `.nvmrc`. With nvm:

```bash
nvm install 24.20.0 && nvm use 24.20.0     # nvm-windows: run the terminal as administrator
npm install -g pnpm@11.25.0
```

> Node **≥ 22.13** is a hard minimum, not a preference: ESLint 10, Prisma 7 and pnpm 11 refuse to
> run below it. `engine-strict` is on, so the install fails clearly rather than halfway.

## 2. Install

```bash
git clone https://github.com/adlanehzx/Nexus.git nexus && cd nexus
cp .env.example .env         # the defaults are enough locally
pnpm install
pnpm docker:up               # postgres + redis + api
pnpm db:migrate              # apply the schema
```

Check that it answers:

```bash
curl http://localhost:3000/health          # liveness  → 200
curl http://localhost:3000/api/v1/health   # readiness → 200 + dependency state
```

For hot reload, run only the data services in containers:

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis
pnpm --filter @nexus/api dev
```

## 3. Operating an instance

`nexus` is the command that installs, diagnoses and backs up an instance — a CLI rather than a
document, because manual setup had a measurable cost: a systemd unit pointing at the wrong
directory, an ephemeral signing key that silently disabled service authentication, a database one
migration behind. None of those raise an error at startup; all of them surface later, at the worst
moment.

```bash
pnpm nexus doctor            # what works, what is missing, and the gesture that fixes it
pnpm nexus setup             # bring the installation into conformance (idempotent)
pnpm nexus backup --verify   # full backup, then prove it is restorable
pnpm nexus restore <archive> # restore onto this installation
pnpm nexus policy check --path ~/.ssh/id_ed25519   # what the local policy decides, and why
pnpm nexus voice check       # which voice dependency is missing, and how to install it
```

`doctor` reports in five groups that follow the question you actually ask when something is
broken — configuration, data, agents, security, systemd — rather than the technical layers, which
you would have to translate before acting. A `warn` is not a disguised `fail`: only a `fail` exits
non-zero, because a diagnostic that is always red gets ignored and one that is always green says
nothing.

## 4. Commands

| Command                              | Effect                                                           |
| ------------------------------------ | ---------------------------------------------------------------- |
| `pnpm dev`                           | Start services in development mode (hot reload)                  |
| `pnpm build`                         | Build every package (Turborepo, ordered by the dependency graph) |
| `pnpm typecheck`                     | `tsc --noEmit` across the monorepo                               |
| `pnpm lint` / `pnpm lint:fix`        | ESLint 10, type-aware                                            |
| `pnpm test` / `pnpm test:watch`      | Vitest                                                           |
| `pnpm format` / `pnpm format:check`  | Prettier                                                         |
| **`pnpm verify`**                    | **build + lint + typecheck + test — the gate before committing** |
| `pnpm test:pg`                       | Store tests against a real PostgreSQL with pgvector              |
| `pnpm db:migrate`                    | Create and apply a migration (development)                       |
| `pnpm db:generate`                   | Regenerate the Prisma client                                     |
| `pnpm docker:up` / `:down` / `:logs` | Local Docker stack                                               |
| `pnpm clean`                         | Remove `dist`, `.turbo` and `node_modules`                       |

## 5. Environment variables

All are declared in [`.env.example`](.env.example) and **validated at startup** by `@nexus/config`
(Zod). A missing or mistyped variable prevents boot — a service that refuses to start is better
than one that fails at 3 a.m. on an absent key.

| Variable                               | Default                 | Role                                                    |
| -------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `NODE_ENV`                             | `development`           | `development` \| `test` \| `production`                 |
| `LOG_LEVEL`                            | `info`                  | `fatal` … `trace`                                       |
| `API_VERSION`                          | `1.0.0`                 | Version exposed by readiness (commit SHA in production) |
| `API_HOST` / `API_PORT`                | `0.0.0.0` / `3000`      | HTTP listener                                           |
| `CORS_ORIGINS`                         | `http://localhost:3000` | Comma-separated; `*` is **refused** in production       |
| `SHUTDOWN_TIMEOUT_MS`                  | `10000`                 | Grace period for in-flight requests on shutdown         |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `100` / `1 minute`      | Per-IP limiting                                         |
| `DATABASE_URL`                         | —                       | **Required.** `postgresql://` URL                       |
| `REDIS_URL`                            | —                       | **Required.** `redis://` URL                            |
| `PUBLIC_API_URL`                       | —                       | Address your devices can reach. Required for QR pairing |
| `EXPECTED_WORKER_VERSION`              | —                       | Advisory only: flags workers that are behind            |

`POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` are read only by Docker Compose to
initialise the container.

**No secret is committed.** `.env` is git-ignored; `.env.example` lists keys, never values.

`PUBLIC_API_URL` deserves a word, because it is configured rather than derived from the `Host`
header. That header is chosen by the caller, so a QR code deriving its address from it would let
any request decide where a phone sends its public key. Absent, pairing is refused with a message
naming the setting — producing a QR that leads somewhere else would be worse, because the symptom
would appear on the phone, far from the cause.

## 6. Architecture

Full documentation: **[docs/README.md](docs/README.md)** — 34 architecture documents, 16 ADRs, a
roadmap and a risk register.

```
apps/                    clients
  mobile/                iPhone — Expo / React Native
  desktop/               Vite + Tauri v2 — Windows, macOS, Linux
  dashboard/             Administration — Vite/React, ADMIN role
  web/                   Vite + React
services/
  api/                   Fastify — REST v1, WebSocket, auth
  agent/                 NEXUS native ACP runtime
  browser-worker/        Python — browser-use
  windows-worker/        Windows executor
  android-worker/        Android executor
  mission-engine/        Python — durable mission DAG
packages/
  shared/                errors, UUID v7, redaction, versions
  config/                environment validation
  protocol/              WebSocket envelopes, DTOs
  database/              Prisma + PostgreSQL
  auth/                  tokens, passwords, mission grants
  agent-core/            loop, planner, execution policies
  tools/                 registry, executor, permissions, confirmations
  llm/                   provider port + CLI and local adapters
  memory/                memory port and implementation
  mcp/                   MCP clients → ToolRegistry
  browser-client/        Browser Worker client
  mission-control-client/ Mission Engine contract
  worker-core/           runtime shared by executors (portable to Hermes)
  client-core/           client core — session, realtime, state, offline, crash
  devices/               registry, selector, tasks, pairing, updates
  device-policy/         local device policy, verifiable refusals
  voice/                 local dictation and speech — whisper.cpp, Piper
  cli/                   the `nexus` command
evals/
  security/              adversarial corpus: the model is assumed compromised
mcp/
  github/ filesystem/    configuration presets
infrastructure/           Dockerfiles, compose, Kubernetes
packaging/                Arch PKGBUILD, Windows installer and service
```

### Dependency rules

Enforced by review and by the Turborepo graph; they are not decorative:

```
agent-core ──▶ llm · tools · memory · protocol · shared     allowed
agent-core ──╳ database · mcp · browser-client              forbidden
tools      ──╳ llm                                          forbidden
api        ──▶ agent-core (composition and routes only)     allowed
```

`agent-core` receives an `AgentRunStore` port rather than Prisma: that is what makes the loop
testable without a database and replayable on an in-memory state. The API is the composition root.

`worker-core` additionally runs on Hermes, the JavaScript engine on Android, so it imports no
`node:` API — a test enforces it. One such import would break the Android bundle, and the error
would only appear on the phone, at the worst possible place to discover it.

### Agent engine

The core is implemented and tested: durable loop, tool registry, deny-by-default permissions,
confirmations bound to a hash of the arguments, cancellation, budgets, retry with backoff, and
tracing without secrets.

Documentation: [`packages/agent-core/README.md`](packages/agent-core/README.md) ·
[`docs/architecture/16-agent-core.md`](docs/architecture/16-agent-core.md)

```ts
const { record, confirmation } = await orchestrator.run({
  userId,
  conversationId,
  message: "Send a message to Marie",
});
// record.status === "waiting_for_confirmation" → show `confirmation`
await orchestrator.resume(record.runId, "approved");
```

### Browser automation with no API key

NEXUS uses Browser Use's official `browser-harness` with a dedicated local Chromium. Reasoning
comes from the ACP subscription already connected, so no Gemini, OpenAI, Anthropic or Browser Use
key is needed:

```bash
./scripts/setup-browser-use.sh
```

The script installs the pinned harness version, disables telemetry and recordings, creates a
separate Chromium profile, registers the agent skills and enables the systemd user service.

### Local voice

Dictation through whisper.cpp, speech through Piper, both on the machine. Dictation carries
everything you say out loud at home, and a transcription API would receive the raw audio of a
living-room microphone — including the sentences that were not meant for an assistant.

**No audio is kept.** That is the default, not an option, and it does not rest on discipline: a
single module owns it, deletion is _verified_ rather than assumed, and the cleanup runs in a
`finally` so the error path — precisely the one you would forget — is covered. What is _not_
guaranteed is written down too: unlinking a file does not overwrite the sectors.

## 7. Testing and proof

A green check proves nothing unless it can go red. What the CI actually demonstrates, job by job:

| job                | what it proves                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `node`             | build, lint, typecheck and the unit suites across the monorepo                                                     |
| `mission-engine`   | the Python engine against its own suite                                                                            |
| `persistence`      | the Prisma stores against a real PostgreSQL, not a double                                                          |
| `e2e-confirmation` | a human confirmation survives a real engine restart (SIGTERM, relaunch)                                            |
| `e2e-chain`        | a chat message crosses a DAG of real ACP agents: parallelism, result passing, profile fallback, restart, synthesis |
| `backup-restore`   | an archive is restorable, and a single altered byte is refused                                                     |
| `blank-machine`    | tracked files only, installed from scratch, then missions, conversations and agents are found again                |
| `desktop-compile`  | the Tauri shell compiles outside Windows                                                                           |
| `provenance`       | every commit in a pull request is signed off                                                                       |
| `security`         | gitleaks, a blocking dependency audit, and the adversarial corpus                                                  |

The adversarial corpus assumes **the model is already lost**: prompt injection succeeded and the
agent does exactly what the attacker asked. The pass criterion is not "the model resisted" —
unmeasurable, and different with every model — but **"no unauthorised action was executed"**, which
is measured on side effects.

Writing those tests found real defects that no amount of reading had: device keys that lived only
in memory and vanished on every API restart, an enum value declared in the schema that no
migration ever created, a desktop shell that could not build outside Windows. See
[CONTRIBUTING.md](CONTRIBUTING.md#a-test-must-be-able-to-fail) for the two cases where a test
could not fail at all.

## 8. Local development

### Package layout

```
packages/<name>/
  src/index.ts          public entry point
  test/*.test.ts        tests
  tsconfig.json         typecheck (src + test)
  tsconfig.build.json   build (src only) → dist/
  package.json          exports pointing at dist/
```

Each package **declares what it uses**: `node-linker=isolated` forbids phantom dependencies. If an
import fails after `pnpm install`, the dependency is missing from that package's `package.json` —
that is the mechanism working, not a bug.

### Conventions

- **Strict ESM.** `"type": "module"`, `moduleResolution: NodeNext`: relative imports carry the
  `.js` extension even in TypeScript.
- **Strict TypeScript**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `erasableSyntaxOnly`.
- **Zod is the source of truth** for data shapes: one schema serves as validator, type and OpenAPI
  documentation, so the API docs cannot drift from the API.
- **Logs are events**, not sentences: the `event` field is a stable enumeration.
- **One `correlationId` per request**, accepted from upstream or generated, returned in the
  `x-request-id` header and present in every log line.
- **Comments explain why.** What the code does is readable from the code; why it was done this way,
  and what breaks otherwise, is not.

### Adding a route

1. Describe input and output in `@nexus/protocol` (Zod).
2. Create the route module in `services/api/src/routes/v1/`, typed `FastifyPluginCallbackZod`.
3. Register it in `src/app.ts` under the `/api/v1` prefix.
4. Add a test in `services/api/test/` via `app.inject()` — no port, no external service.

### Database

```bash
pnpm db:migrate --name add_table_x   # create and apply a migration
pnpm db:generate                      # after a schema change
```

Prisma 7: the connection URL no longer lives in `schema.prisma`. Migrations read it from
`packages/database/prisma.config.ts`, and the client receives it through the `pg` driver adapter.
Identifiers are **application-generated UUID v7** (`uuidv7()` from `@nexus/shared`): time-sorted,
so no index fragmentation.

Migrations are additive and apply with:

```bash
pnpm --filter @nexus/database migrate:deploy
```

## 9. Docker

```bash
pnpm docker:up      # postgres + redis + api, dependencies gated on healthchecks
pnpm docker:logs
pnpm docker:down
```

The API image is built in three stages (dependencies → build → runtime). The final image contains
only compiled JavaScript and production dependencies: no TypeScript sources, no build tools. It
runs as the `node` user with `dumb-init` as PID 1, so `SIGTERM` actually reaches the process and
triggers a graceful shutdown.

## 10. Contributing

NEXUS is written largely by AI agents under human review, and we say so plainly rather than let you
find out from the commit trailers. Contributions are welcome whatever typed them, provided you have
read what you submit and can explain it.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the environment, the rules, the DCO sign-off and the
contributor licence agreement. Report vulnerabilities privately per [SECURITY.md](SECURITY.md).

## Licence

[AGPL-3.0-or-later](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
