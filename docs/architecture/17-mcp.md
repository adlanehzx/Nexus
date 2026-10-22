# 17 — Model Context Protocol (MCP) Implementation

Describes the MCP subsystem **as built in the codebase**. Document [04 — Tools System & MCP](04-tools-mcp.md)
establishes the conceptual foundation; this document reflects the implemented code. Package: [`@nexus/mcp`](../../packages/mcp).

## 1. Architecture Flow

```
MCP Server ─▶ McpClient ─▶ McpToolAdapter ─▶ ToolRegistry ─▶ Agent Core
                             └▶ McpResourceAdapter ─┘
                 ▲
             McpManager  (Lifecycle, health probes, auto-reconnect, circuit breaker)
```

`agent-core` does not depend on `@nexus/mcp` — prohibited by monorepo boundary rules. Decoupling is
maintained via `ToolRegistry`: `McpManager` registers `ToolDefinition` instances into the registry,
which the agent consumes without coupling to the underlying transport.

## 2. Standard Protocol SDK Integration

`@modelcontextprotocol/sdk` handles protocol primitives: handshakes, JSON-RPC framing, schemas, and
stdio / Streamable HTTP / SSE transports. `McpClient` wraps the SDK to provide:

- Strict operational timeouts (`connectTimeoutMs`, `requestTimeoutMs`);
- Error translation into the standard `@nexus/errors` taxonomy;
- Credential vault secret resolution upon startup;
- Upstream connection drop notifications to `McpManager`.

Test suites exercise the SDK **end-to-end**: real `McpServer` instances interact with our real `Client`,
communicating via `InMemoryTransport.createLinkedPair()` or spawned child processes over stdio.

## 3. Schema Validation: Native JSON Schema

MCP servers declare input schemas using JSON Schema. Two implementation strategies were considered:
translating to Zod, or validating directly against the raw JSON Schema.

We validate against original JSON Schemas using `@cfworker/json-schema` — the validator used within
the official MCP SDK. Benefit: **identical evaluation verdicts on both client and server**. Any partial
transpilation into Zod risked accepting payloads that the MCP server would reject, or vice versa.

The native JSON Schema is passed to the LLM via `ToolDefinition.inputJsonSchema`. The planner prioritizes
this schema when present.

## 4. Unidirectional Risk Escalation

Two security governance rules:

1. **Human Configuration is Authoritative.** Explicit user policy is the only mechanism permitted to
   lower the risk tier of an MCP tool.
2. In the absence of an explicit human override, tools default to **`MEDIUM`**, and server annotations
   can only **escalate** risk: `destructiveHint` escalates to `HIGH`, `openWorldHint` maintains `MEDIUM`,
   and `readOnlyHint` never downgrades risk.

As stated in the official MCP specification: _"Clients should never make tool use decisions based on
ToolAnnotations received from untrusted servers."_ Automated test suites verify that a server annotating
both `readOnlyHint: true` and `destructiveHint: true` resolves to `HIGH`.

Retry policy: MCP tools are only automatically retried if classified as `SAFE` or `LOW` by human policy.
Server-asserted `idempotentHint` attributes are treated as untrusted.

## 5. Fault Tolerance and Circuit Breaker

| Event Trigger          | System Response                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Connection Drop        | Lifecycle event logged, followed by automated reconnection with capped exponential backoff         |
| Active Downtime        | Returns `MCP_SERVER_UNAVAILABLE` — retryable, actionable error message for the agent               |
| N Consecutive Failures | Circuit breaker trips open: server tools are **temporarily removed from registry**                 |
| Reset Timeout Elapsed  | Circuit resets to half-open, permitting a single probe execution                                   |
| Startup Probing        | Servers connect concurrently in parallel; an unresponsive server never blocks overall service boot |

An internal connection state guard (`connecting`) prevents initial handshake failures from spawning
concurrent reconnect loops alongside `start()`, ensuring deterministic health status reporting.

## 6. Secret Isolation and Redaction

Raw credentials are never stored in plain text configuration: settings hold **vault references**
(`envRefs`, `headerRefs`), resolved at launch time via the encrypted credential store.
`describeConfig()` exposes only secret reference keys.

On local workstations, credentials integrate with the OS session keyring via `secret-tool` / DPAPI.
The web dashboard transmits secrets through write-only endpoints, receiving back opaque reference handles.
`McpManager` and the tool registry initialize during API boot; adding, reconnecting, or removing servers
requires zero backend restarts.

Spawned stdio child processes receive only `getDefaultEnvironment()` (`PATH`, `HOME`, etc.) alongside
explicitly granted environment references. Zero backend secrets are inherited by default — verified by
unit tests with canary environment variables.

## 7. Refinements from Design Spec (Doc 04)

| Dimension            | Document 04                  | Implemented Code                          | Justification                                                                                |
| -------------------- | ---------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Default Risk Tier    | `CONFIRM`                    | `MEDIUM`                                  | Aligns with the 5-tier risk hierarchy ([16](16-agent-core.md) §2)                            |
| Schema Parsing       | JSON Schema → Zod            | Validates against native JSON Schema      | Eliminates translation edge cases (§3)                                                       |
| Resources            | Unspecified                  | Exposed as two `SAFE` tools               | Agent core interacts uniformly with tools                                                    |
| Container Sandboxing | Dedicated `mcp-runner` image | Process-level environment isolation in v1 | Sandboxed containers configured for deployment targets; process isolation active immediately |

## 8. Server Registration Guide

For configuration examples, permission policies, presets, remote transports, and diagnostics, refer to
[`packages/mcp/README.md`](../../packages/mcp/README.md).
