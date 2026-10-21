# ADR-002 — Fastify as HTTP Framework

**Status**: Proposed · 2026-09-01

## Context

The API must serve versioned REST endpoints, WebSockets, audio uploads, and generate reliable
OpenAPI documentation. It must remain a **thin boundary**: validation, authentication, and
orchestration — business logic lives in services and domain packages.

## Decision

Fastify 5 with `fastify-type-provider-zod`, `@fastify/websocket`, `@fastify/swagger`,
`@fastify/rate-limit`, and `@fastify/helmet`.

## Alternatives

- **NestJS.** Rich scaffolding, built-in DI, mature ecosystem. Rejected: the weight of decorators
  and modules exceeds our needs, and its opinionated DI would conflict with the explicit dependency
  injection chosen for `agent-core`. The "SOLID without over-engineering" principle applies here.
- **Express.** Largest ecosystem, but lacks native schema validation, weak typing, lower
  performance, and its middleware model makes encapsulation harder.
- **Hono / Elysia.** Excellent and modern, but younger ecosystem; we prefer maturity for our most
  exposed boundary component.

## Consequences

**Positive** — A single Zod schema per route simultaneously validates, types, and documents: the
OpenAPI documentation cannot drift. Encapsulated plugins provide natural domain isolation.
Comfortable performance for streaming.

**Negative, accepted** — No enforced structure: layer discipline (routes → services → repositories)
must be maintained through code review and lint rules rather than framework opinions. Fewer tutorials
compared to Express or Nest.
