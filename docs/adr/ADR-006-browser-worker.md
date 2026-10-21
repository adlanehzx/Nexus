# ADR-006 — Browser Use as an Isolated Python Service

**Status**: Proposed · 2026-09-01

## Context

`browser-use` is a Python library. The backend is written in TypeScript. The architectural
guidelines explicitly forbid the TypeScript backend from directly importing Python code, and
mandate worker isolation. Two realities reinforce this: Chromium consumes substantial memory and
is prone to crashes, and by definition it navigates potentially hostile external web content.

## Decision

`apps/browser-worker`: A FastAPI service in a dedicated container, exposing a versioned HTTP API
(sessions, act, cancel, health) and publishing execution progress to a Redis Stream. The TypeScript
layer interacts exclusively through `@nexus/browser-client`, a typed client. The service runs in an
isolated Docker network without published host ports, filtered egress, and zero application secrets
inside the container.

Two tiers of tools are exposed to the agent: `browser.act` (high level, `browser-use` loop,
resource intensive, `CONFIRM` on mutating actions) and `browser.navigate/extract/click/type`
(low level, deterministic, fast).

## Alternatives

- **Playwright directly in TypeScript.** Eliminates Python and network hops — but would require
  reimplementing the perceptual intelligence of `browser-use` (page analysis, DOM element resolution,
  vision-action loop), which is precisely the library's value proposition. Remains a fallback option
  if `browser-use` proves unstable; the `browser.*` tool interface would remain unchanged.
- **In-process bridge (`python-shell`, PyO3).** Violates decoupling constraints, tightly binds
  lifecycles, and a Chromium crash could bring down the agent worker.
- **SaaS navigation service (Browserbase, Steel).** Less operational overhead, but introduces
  external dependencies, recurring costs, and streams private browsing data through a third party.
  Can be considered later behind the same interface.

## Consequences

**Positive** — Fault and security isolation; independent scaling; ability to swap out the
implementation without modifying agent logic; step-by-step screenshot streaming serving both as a
feature and as the primary debugging tool.

**Negative, accepted** — Two distinct language toolchains to maintain and build (mitigated by
contract tests, cf. [15-testing](../architecture/15-testing.md) §4); slight network latency (negligible
compared to multi-second browser operations); heavy Docker image (~1.5 GB with Playwright and
browser binaries).
