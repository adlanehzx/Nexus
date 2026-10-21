# ADR-005 — MCP as a Tool Source, Not the Architectural Core

**Status**: Proposed · 2026-09-01

## Context

MCP standardizes exposing tools to a model and provides access to an existing ecosystem of servers
(GitHub, filesystem, databases, etc.). The temptation is to treat it as the universal integration
model: "everything is MCP". The specifications mandate being able to "connect multiple MCP servers
without modifying agent core".

## Decision

MCP is **one of five `ToolSource` adapters** (builtin, MCP, browser, device, HTTP).
`McpManager` connects servers (stdio or HTTP/SSE), discovers their tools, and translates them into
internal `ToolDefinition` instances: JSON Schema → Zod, MCP errors → `ToolError`, name →
`mcp.{slug}.{tool}`.

Three governance rules:

1. A discovered MCP tool enters with **`CONFIRM`** risk level by default; lowering it is an
   explicit, persisted human decision, never deduced from the description provided by the server.
2. The description of a third-party server is **untrusted input** (potential prompt injection):
   truncated, escaped, incapable of modifying the system prompt.
3. stdio servers run inside an isolated sandbox container, network-less by default, with minimal
   environment variables — no backend environment secrets are inherited.

## Alternatives

- **Expose everything via MCP, including native tools.** Seductive uniformity, but introduces
  serialization overhead and process hops for internal calls, loses end-to-end Zod typing, and
  couples internal architecture to external protocol revisions.
- **Ignore MCP, handcraft everything.** Loses the broader ecosystem and user extensibility required
  by the specifications.

## Consequences

**Positive** — Adding an MCP server from the UI touches neither `agent-core` nor codebase: it is a
database entry. MCP tools automatically inherit permissions, confirmations, timeouts, audit logs,
and circuit breakers. If MCP evolves, only a single adapter package changes.

**Negative, accepted** — JSON Schema → Zod translation overhead (edge cases: `oneOf`, recursive
schemas — in which case we reject the tool with a clear diagnostic rather than guessing). A slow or
unstable MCP server could degrade performance: mitigated by circuit breakers and automated tool
deregistration upon repeated failures.
