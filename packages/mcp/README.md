# @nexus/mcp

Connects to Model Context Protocol (MCP) servers and adapts their tools into the central `ToolRegistry`.

**Status: Implemented and tested.** 35 tests, including a live MCP child process server
(spawn, environment isolation, crashes, auto-reconnect).

---

## Architectural Flow

```
MCP Server  ─▶  McpClient  ─▶  McpToolAdapter  ─▶  ToolRegistry  ─▶  Agent Core
   (SDK)       (SDK + Timeouts, (JSON Schema,       (Standard
                Secrets,         Permissions,        ToolDefinition)
                Errors)          Risk Tiers)
```

**The agent core does not know about MCP.** It interacts strictly with `ToolDefinition` instances:
same contract, same permissions, same confirmation gates, same executor. Adding an MCP server touches
not a single line of `agent-core` code (ADR-005).

The protocol is not reimplemented: the official `@modelcontextprotocol/sdk` handles MCP framing on
both sides — including in unit tests, where a genuine `McpServer` answers our real `Client`.

---

## Adding a New MCP Server

### 1. Basic Setup: Declarative Configuration

```ts
import { McpManager, parseMcpServerConfig } from "@nexus/mcp";

const config = parseMcpServerConfig({
  name: "weather", // Lowercase alphanumeric with hyphens — prefixes tool names
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/mcp-server-weather"],
  env: { REGION: "eu" }, // Non-sensitive values
  envRefs: { API_KEY: "vault://weather" }, // Secrets: reference handles only
  defaultPermissions: ["weather.read"],
});

const manager = new McpManager({ registry, configs: [config] });
await manager.start();
```

Tools appear under `mcp.weather.<toolName>` and become immediately available to the agent —
**provided the user has authorized the declared permission keys**.

### 2. Tuning Permission Policies

By default, every discovered tool enters at risk level **`MEDIUM`**, requiring human confirmation
on each call. This is intentional: third-party MCP servers are untrusted external code.

To make an MCP server ergonomic for everyday use, **explicitly downgrade** safe read-only tools:

```ts
{
  defaultPermissions: ["weather.read"],
  defaultRisk: "MEDIUM",
  toolPolicies: {
    get_forecast: { risk: "SAFE", permissions: ["weather.read"] },
    get_alerts:   { risk: "SAFE", permissions: ["weather.read"] },
    subscribe:    { risk: "HIGH", permissions: ["weather.write"] },
    debug_dump:   { disabled: true }, // Excluded from tool registry
  },
}
```

| Policy Field           | Effect                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| `risk`                 | Final risk tier. The **only** mechanism that can downgrade an MCP tool risk |
| `permissions`          | Required permissions; without them, the tool is hidden from the model       |
| `requiresConfirmation` | Forces or waives confirmation modal dialogs, independent of risk level      |
| `timeoutMs`            | Custom execution timeout for this specific tool                             |
| `disabled`             | Excludes the tool from registry discovery                                   |

### 3. Using Builtin Presets

Pre-configured presets with established permission policies are available:

```ts
import { githubPreset, filesystemPreset } from "@nexus/mcp";

githubPreset({ tokenRef: "vault://github" }); // Read-only
githubPreset({ tokenRef: "vault://github", allowWrite: true }); // + Write operations requiring confirmation

filesystemPreset({ roots: ["/workspace/project"] }); // Read-only path sandbox
```

These presets serve as blueprints: copy `src/presets.ts` to configure new servers rapidly.

### 4. Remote Transports

```ts
{
  name: "remote-server",
  transport: "http",
  url: "https://mcp.example.com/v1",
  headerRefs: { Authorization: "vault://mcp-remote" },
}
```

`http` utilizes the modern Streamable HTTP SDK transport; `sse` uses legacy Server-Sent Events.

---

## Security Invariants

| Security Rule                | Implementation Mechanics                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero Secrets in Logs         | `describeConfig()` yields only configuration **keys** for `env`/`headers`, never raw values. Tested in CI.                                                                                                             |
| Isolated Credentials         | Secrets pass through `envRefs`/`headerRefs` resolved at boot time via vault. They are neither stored in plaintext config nor visible to model prompts.                                                                 |
| Zero Environment Inheritance | Spawned child processes receive only `getDefaultEnvironment()` + explicit parameters. Backend environment keys do not leak. **Tested against real processes.**                                                         |
| Untrusted Tool Descriptions  | Tool descriptions originate from third parties: bounded character length, XML/HTML tags stripped, and provenance clearly demarcated.                                                                                   |
| Untrusted Server Annotations | `destructiveHint` can **escalate** risk; `readOnlyHint` can never downgrade it. Official MCP specification: _"Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers."_ |
| Input Argument Validation    | Inputs validate against the **server's native JSON Schema** using `@cfworker/json-schema` — ensuring identical verdicts on client and server.                                                                          |
| No Blind Automatic Retries   | A tool is only automatically retried if classified by human policy as `SAFE` or `LOW`.                                                                                                                                 |
| Bounded Operational Delays   | `connectTimeoutMs` for handshake, `requestTimeoutMs` (or per-tool overrides) on execution calls.                                                                                                                       |

---

## Fault Tolerance and Circuit Breaker

Server outages are treated as expected runtime events:

1. **Disconnect Detected** → Emits `server.disconnected` event.
2. **Automated Reconnection** with exponential backoff up to `maxReconnectAttempts`. Tools are republished upon reconnect.
3. **During Outages**, calls fail with `MCP_SERVER_UNAVAILABLE`: actionable, retryable error message explaining the outage to the LLM.
4. **After `circuitBreakerThreshold` Failures**, the circuit trips open and tools **are removed from the registry**:
   describing failing tools in prompts wastes tokens and triggers repetitive retries.
5. **After `circuitBreakerResetMs`**, the circuit closes to half-open, permitting probe executions. `manager.reconnect(name)` forces immediate reconnect.

The agent never crashes, and other connected MCP servers remain completely unaffected.

---

## Programmatic API

```ts
await manager.start(); // Connects all servers, registers tools
await manager.addServer(config); // Live registration without restarting API
await manager.removeServer("github");
await manager.refreshToolList("github"); // Re-scans server capabilities
await manager.reconnect("github"); // Forces reconnect and resets circuit breaker
await manager.stop(); // Graceful shutdown

manager.health(); // Status across all servers
manager.healthOf("github");
manager.toolNames("github");
manager.describe(); // Sanitized configuration omitting secret values
```

`health()` returns: `status`, `toolCount`, `lastError`, `consecutiveFailures`,
`reconnectAttempts`, `circuitOpenUntil`, `serverInfo`.

Events: `server.connected`, `server.disconnected`, `server.failed`, `server.circuit_opened`,
`server.circuit_closed`, `tools.registered`, `tools.unregistered`.

---

## MCP Resources

An MCP resource is URI-addressable data. Because the agent core interacts with the external world
strictly via tool calls, resources are exposed as two read-only (`SAFE`) tools:

- `mcp.<server>.resources.list`
- `mcp.<server>.resources.read`

Can be disabled per server via `exposeResources: false`.

---

## Troubleshooting Diagnostics

| Symptom                          | Probable Cause                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `status: "failed"` at startup    | Executable not found, or child process crashed immediately — inspect `lastError` |
| Tools missing from registry      | Permission grants missing (tools are hidden from model), or `disabled: true`     |
| Confirmation prompt on every run | Default `MEDIUM` risk: downgrade read-only tools in `toolPolicies` configuration |
| `MCP_SCHEMA_UNSUPPORTED`         | Input schema unsupported; tool discarded while server remains operational        |
| `status: "circuit_open"`         | Consecutive failure threshold exceeded; invoke `reconnect()` to force reset      |
