# 04 — Tools System & MCP

## 1. `ToolDefinition` — The Universal Contract

Everything capable of affecting state in the world is a tool, defined by a single unified structure
regardless of implementation (native TypeScript, MCP, browser automation, device agent, or HTTP).

```ts
interface ToolDefinition<I = unknown, O = unknown> {
  name: string; // 'mail.send' — namespaced, stable, unique
  version: string; // semver; prompt receives major version
  title: string; // UI label
  description: string; // For the LLM: when to use AND when NOT to use
  inputSchema: ZodType<I>; // Validated before execution, always
  outputSchema: ZodType<O>; // Validated after execution, always
  permissions: PermissionKey[]; // e.g. ['mail:send']
  riskLevel: "SAFE" | "CONFIRM" | "CRITICAL";
  requiresConfirmation: boolean | ((input: I, ctx: ToolContext) => boolean);
  idempotent: boolean;
  sideEffects: "none" | "local" | "external" | "irreversible";
  timeoutMs: number;
  retry: { attempts: number; backoff: "exp" | "none" };
  costHint?: { unit: "call" | "token" | "usd"; value: number };
  fallbackTool?: string;
  redact?: (io: unknown) => unknown; // Applied prior to logging and persistence
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
```

`requiresConfirmation` accepts a predicate function: `fs.write` targeting `~/scratch/note.md` carries
fundamentally different risk than targeting `/etc/hosts`, and `mail.send` to oneself carries different
risk than dispatching to an external mailing list. **Risk depends on evaluated arguments, not merely
tool identity** — an essential subtlety of the security architecture.

```ts
type ToolResult<O> =
  | { ok: true; output: O; artifacts?: Artifact[]; summaryForModel: string; metrics: Metrics }
  | { ok: false; error: ToolError; partial?: unknown; summaryForModel: string };
```

`summaryForModel` is distinct from raw `output`: the model receives a bounded projection (≤ ~2k tokens)
while the complete payload is stored as an auditable artifact. This prevents large outputs (e.g. 3 MB
file reads) from blowing up the inference window.

## 2. `ToolRegistry`

```ts
interface ToolRegistry {
  register(source: ToolSource): void; // Native | MCP | Browser | Device | HTTP
  listFor(ctx: UserContext): ToolDefinition[]; // Filtered by grants AND context
  get(name: string, version?: string): ToolDefinition | undefined;
  onChange(cb): Unsubscribe; // MCP hot-reloading
}
```

The registry is populated by **ToolSource** adapters. Adding capabilities means registering a new
source; the agent core logic remains unchanged.

```
ToolSource
├── BuiltinToolSource      Native TypeScript tools
├── McpToolSource          One per connected MCP server, dynamic discovery
├── BrowserToolSource      Exposes browser.* (proxies to the Python browser-worker)
├── DeviceToolSource       Exposes device.* (proxies to connected Device Agents)
└── HttpToolSource         Declarative YAML tools compiled from OpenAPI specifications
```

`listFor` applies a **two-phase filter**: by user permission grants, and by active environment context
(e.g. `device.*` tools only appear if an associated device is currently online). A tool we do not want
the model to invoke is never described in the prompt — the strongest defense against unauthorized actions.

## 3. `ToolExecutor` — The Execution Boundary

A single, unified pipeline with zero bypasses:

```
1.  resolve       registry.get(name) → otherwise ToolNotFound (observation, not a crash)
2.  validate      inputSchema.parse(args) → otherwise ValidationError returned to model
3.  authorize     PermissionService.check(user, tool, args, ctx)
4.  confirm       If required: persist Confirmation → suspend run, release worker
5.  idempotency   Key (runId, stepIndex, tool, hash(args)) → if executed: replay cached result
6.  persist       ToolExecution(status=RUNNING) — BEFORE invocation, never after
7.  execute       AbortSignal + timeout + retry + per-source circuit breaker
8.  validate out  outputSchema.parse → otherwise ToolExecutionError(phase='output')
9.  redact        Strip secrets before logging and database persistence
10. persist       ToolExecution(status, output, metrics, cost)
11. summarize     Bounded projection for LLM + artifact references
12. emit          tool.started / tool.progress / tool.result on WebSocket gateway
```

Step 6 prior to invocation is crucial: if a worker crashes during an external API call, the system
knows upon restart that an execution was in-flight and avoids blind retries.

**Per-source circuit breaker**: If an MCP server fails 5 consecutive times, its circuit trips open for
60s, its tools are temporarily removed from `listFor`, and the agent is informed. An unstable MCP
server cannot degrade overall platform reliability.

## 4. Default Tool Catalog

| Tool                            | Risk Level                      | Confirmation Required | Notes                                    |
| ------------------------------- | ------------------------------- | --------------------- | ---------------------------------------- |
| `search.web`                    | SAFE                            | No                    | External search provider                 |
| `http.request`                  | CONFIRM                         | GET no / Others yes   | Domain allowlist validation              |
| `weather.get`                   | SAFE                            | No                    | Read-only utility                        |
| `calendar.list`                 | SAFE                            | No                    | Google Calendar OAuth                    |
| `calendar.create` / `.update`   | CONFIRM                         | Yes                   | Scoped event manipulation                |
| `calendar.delete`               | CONFIRM → CRITICAL if recurring | Yes                   | Irreversible for recurring events        |
| `mail.list` / `mail.read`       | SAFE                            | No                    | Read-only email access                   |
| `mail.send`                     | CONFIRM                         | Yes                   | Full preview card mandatory in dashboard |
| `memory.search` / `.write`      | SAFE                            | No                    | Core personal memory                     |
| `device.fs.read`                | SAFE                            | No                    | Enforces per-device path jail            |
| `device.fs.write`               | CONFIRM                         | Yes                   | File diff displayed before execution     |
| `device.fs.delete`              | CRITICAL                        | Yes                   | Soft delete / trash where supported      |
| `device.shell.exec`             | CONFIRM                         | Yes                   | Command classification policy enforced   |
| `device.process.list` / `.kill` | SAFE / CONFIRM                  | Contextual            | Kill requires explicit confirmation      |
| `github.*`                      | SAFE read, CONFIRM write        | Yes on write          | Pull requests, commits, merges           |
| `browser.act`                   | CONFIRM                         | Yes on mutating act   | See [05](05-browser-use.md)              |
| `payment.*`                     | CRITICAL                        | Strict dual factor    | Out of scope for initial release         |

## 5. Model Context Protocol (MCP)

### Architecture Role

MCP is **one tool source among several**, not the central architectural hub. We leverage the protocol
to access the broader ecosystem of community tools without coupling internal logic to external API
churn — if MCP changes or a server crashes, only the adapter is affected (→ [ADR-005](../adr/ADR-005-mcp-as-adapter.md)).

### `McpManager`

```
McpManager
├── Loads declarative configuration (McpServer table, editable via UI)
├── Launches / connects each server: stdio (child process) or HTTP/SSE (remote)
├── Supervises: healthchecks, backoff restarts, circuit breakers
├── Discovers tools / resources / prompts → maps into ToolDefinition
└── Translates: MCP JSON Schema → Zod, MCP errors → ToolError
```

### Mapping and Security Boundary

- **Namespacing**: `mcp.{serverSlug}.{toolName}`. Prevents name collisions between servers.
- **Default Risk Level**: Dynamically discovered MCP tools default to `CONFIRM`. Upgrading a tool to
  `SAFE` is an explicit human action stored in the database, never deduced from third-party tool
  descriptions. Third-party descriptions are treated as **untrusted input** prone to indirect prompt
  injections (→ [09-security](09-security-permissions.md) §7).
- **Process Isolation**: stdio servers run inside isolated sandbox containers, network-less by default,
  with minimal environment variables — inheriting zero backend secrets.
- **Hot Reloading**: Registering an MCP server from the dashboard does not restart the backend;
  `registry.onChange` applies to subsequent runs while leaving active runs unaffected for reproducibility.

## 6. Declarative HTTP Tools

For simple third-party REST endpoints, writing TypeScript boilerplate is unnecessary. Tools can be
declared in YAML:

```yaml
name: flights.search
description: Search flights between two airport codes for a specific date.
risk: SAFE
auth:
  type: apiKey
  secretRef: FLIGHT_API_KEY # Reference to encrypted vault, never raw secret
request:
  method: GET
  url: https://api.example.com/v1/search
input: { from: string, to: string, date: string }
output: { flights: [{ carrier, price, departAt }] }
```

Compiled into `ToolDefinition` at boot time, benefiting from identical safety guarantees (schema
validation, permissions, timeouts, audit logs). `secretRef` resolves securely through the vault at
execution time.
