# ADR-014 — Zod Contracts as the Single Source of Truth

**Status**: Proposed · 2026-09-01

## Context

Five consumers (mobile, desktop, web, device-agent, browser-worker) rely on the same data structures:
API DTOs, WebSocket event envelopes, tool schemas, and error codes. Each could easily be defined
in conflicting locations — TypeScript types in one package, validation logic in another, handcrafted
OpenAPI docs — guaranteeing eventual drift.

## Decision

`@nexus/contracts` defines each structure **once** using Zod, and all downstream artifacts derive
from it:

```
Zod schema
 ├── TypeScript type          z.infer
 ├── Runtime validation       .parse() across boundaries, bidirectionally
 ├── OpenAPI documentation    @fastify/swagger via fastify-type-provider-zod
 ├── JSON Schema              zod-to-json-schema → LLM tool definitions, Python contract
 └── Pydantic models          Generated for apps/browser-worker, verified via CI contract tests
```

Rules: Zero manually duplicated interfaces; every network envelope carries a version field (`v`);
validation applies **on client reception as well** (the server may run ahead of mobile store releases).

## Alternatives

- **TypeScript types alone.** Stripped at compile time: zero runtime protection against malformed
  payloads, outdated clients, or malicious MCP responses.
- **OpenAPI specs as primary source, generating types.** Effective for REST, but poorly handles
  WebSocket multiplexing and dynamic tool schemas; code-generation CLI tooling introduces fragile build steps.
- **tRPC.** Exceptional for pure TypeScript end-to-end, but our API must be consumed by Python
  services and remain standard REST for third-party integrations.
- **Protobuf.** Robust cross-language typing, but heavy tooling footprint and poor React Native
  ergonomics for limited gain in this context.

## Consequences

**Positive** — A contract change immediately fails the build for all consumers before hitting
production; OpenAPI docs never drift; the Python boundary is locked by automated CI tests.

**Negative, accepted** — Zod incurs slight runtime overhead (negligible compared to LLM call latency,
monitored on hot paths like WebSocket fanout where full validation runs in dev and sampled in prod);
recursive schemas require explicit type annotations; demands strict versioning discipline (`v` in
envelopes, additive evolution only).
