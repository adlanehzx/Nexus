# @nexus/agent-core

Agent execution engine: ingests user requests, produces final answers, and dynamically invokes available
tools under explicit permission policies.

**Status: Implemented and thoroughly tested.** 43 unit tests in this package, 37 in `@nexus/tools`.

---

## Core Contract

> The model can do nothing other than emit text tokens and **request** tool executions. A tool call
> originates strictly from structured blocks emitted by provider adapters — zero prose text is scraped
> to infer tool actions.

## Package Architecture

| Component           | Role                                                                    | Source File           |
| ------------------- | ----------------------------------------------------------------------- | --------------------- |
| `AgentOrchestrator` | Run lifecycle management: create, resume, cancel, trace                | `src/orchestrator.ts` |
| `AgentLoop`         | Core execution loop: observe → reason → authorize → execute             | `src/loop.ts`         |
| `AgentContext`      | Model prompt context: system prompt, memories, conversation transcript  | `src/context.ts`      |
| `AgentState`        | Serializable run state — the foundation of durable suspension           | `src/state.ts`        |
| `Planner`           | Translates state into LLM calls, and outputs into typed decisions       | `src/planner.ts`      |
| `ExecutionPolicy`   | Execution budgets and safeguards defined as **data**                    | `src/policy.ts`       |
| `AgentRunStore`     | Persistence port interface (in-memory implementation included)          | `src/store.ts`        |
| `AgentEventEmitter` | Real-time observability: iterations, tool calls, confirmation prompts   | `src/events.ts`       |
| `redact`            | Credential masking applied prior to logging and tracing                 | `src/redaction.ts`    |

The capability plane — `ToolRegistry`, `ToolExecutor`, `PermissionService`, `ConfirmationService`,
`ToolDefinition` — lives in [`@nexus/tools`](../tools).
`agent-core` depends neither on databases, nor on MCP, nor on vendor SDKs (ADR-003, ADR-004).

## Execution Loop

```
        ┌──────────────────────────────────────────────────────────┐
        ▼                                                          │
   guards ─▶ reason ─▶ decision ─┬─ final answer ─▶ COMPLETED      │
   budget     (LLM)              │                                 │
   timeout                       └─ tool calls                     │
   cancellation                            │                       │
   failures                                ▼                       │
                                    resolve tool                   │
                                    validate arguments (Zod)       │
                                    anti-loop check                │
                                    PermissionService              │
                                      ├─ DENY    ─▶ observation ───┤
                                      ├─ CONFIRM ─▶ WAITING_FOR_   │
                                      │            CONFIRMATION    │
                                      │            (worker freed)  │
                                      └─ ALLOW   ─▶ ToolExecutor ──┘
                                                   timeout · retry ·
                                                   backoff · validation
```

**An execution failure is not an unhandled crash.** Unknown tools, invalid argument schemas, denied
permissions, failed executions, and schema mismatches all become observations fed back to the model on
the next iteration. The loop terminates strictly on exhausted budgets, cancellations, or provider outages.

## States

`pending → running → { completed | incomplete | failed | cancelled }`,
with `waiting_for_confirmation` as an explicit suspended state.

`incomplete` is a first-class state: when budgets are hit, the agent **must** synthesize what it
accomplished and what remains. An agent halting in silence is a product defect.

`stopReason` values: `final_answer`, `max_iterations`, `max_tool_calls`, `global_timeout`,
`tool_failure_limit`, `cancelled`, `confirmation_rejected`, `confirmation_expired`, `provider_error`,
`internal_error`.

## Usage Example

```ts
import { AgentOrchestrator } from "@nexus/agent-core";
import { AnthropicProvider } from "@nexus/llm/anthropic";
import { PermissionService, StaticGrantProvider, ToolRegistry } from "@nexus/tools";

const registry = new ToolRegistry().register(weatherTool).register(emailTool);

const orchestrator = new AgentOrchestrator({
  llm: new AnthropicProvider({ model: "claude-opus-5", effort: "high" }),
  registry,
  permissions: new PermissionService({
    grants: new StaticGrantProvider(["calendar.read", "email.send"]),
    autoApproveMaxRisk: "LOW",
  }),
  policy: { maxIterations: 8, globalTimeoutMs: 120_000 },
});

orchestrator.on((event) => logger.info(event));

const { record, confirmation } = await orchestrator.run({
  userId: "user-1",
  conversationId: "conv-1",
  message: "Check my unread emails and highlight important ones",
});

if (record.status === "waiting_for_confirmation") {
  // `confirmation` holds the exact payload preview to present to the user
  const resumed = await orchestrator.resume(record.runId, "approved");
}
```

### In-Flight Cancellation

The `runId` is emitted via `run.started` **before** `run()` yields control, with state persisted immediately:

```ts
orchestrator.on((e) => {
  if (e.type === "run.started") currentRunId = e.runId;
});
await orchestrator.cancel(currentRunId);
```

## Observability

Every run produces an immutable `AgentRunRecord`:

```ts
{
  runId, userId, conversationId, correlationId,
  startTime, endTime, status, stopReason, iterations,
  toolsUsed: [{ name, riskLevel, status, durationMs, attempts, input, errorCode }],
  errors:    [{ at, code, message, iteration }],
  usage:     { inputTokens, outputTokens },
  model, response,
}
```

**Zero raw credentials appear in records.** Tool arguments pass through `redact()` before entering
traces and event streams: key name masking (`password`, `apiKey`, `authorization`…) **and** pattern
matching (`sk-…`, `ghp_…`, JWT tokens).

## Budgets and Thresholds

| Safeguard                    | Default Value                    | Trigger Behavior                             |
| ---------------------------- | -------------------------------- | -------------------------------------------- |
| `maxIterations`              | 12                               | `incomplete` + synthesis                     |
| `globalTimeoutMs`            | 180,000                          | `incomplete`                                 |
| `maxToolCalls`               | 25                               | `incomplete`                                 |
| `maxConsecutiveToolFailures` | 3                                | `incomplete`                                 |
| `maxIdenticalToolCalls`      | 2                                | Tool call denied, explicit observation added |
| `defaultToolTimeoutMs`       | 30,000                           | `TOOL_TIMEOUT`, retryable                    |
| `retry`                      | 3 attempts, 2x backoff + jitter  | Terminal failure on exhaustion               |
| `autoApproveMaxRisk`         | `LOW`                            | Above this tier: requires confirmation       |

Time spent awaiting human confirmation is **restored to the budget**: wall-clock limits measure agent
compute duration, not human deliberation delays.

## Test Suite Coverage

The LLM is the only mocked boundary (`ScriptedLLMProvider`), alongside backoff clock timers — recorded
without thread sleep delays for exact assertions. Registries, permissions, confirmations, executors,
loops, and state stores run real code.

Covers: simple responses · tool calls · batch tool calls across turns · execution failures · invalid output
schemas · consecutive failure caps · exponential backoff retries · non-retryable terminal errors · non-idempotent
tool safety · hard timeouts on tools ignoring abort signals · global run timeouts · in-flight cancellation ·
canceling suspended runs · permission denials · domain wildcard grants · registry pre-filtering ·
confirmation requests / approvals / rejections · CRITICAL mandatory confirmation · argument-dependent risk ·
payload hash integrity (anti-bait-and-switch) · expiration · iteration limits · tool call ceilings ·
anti-loop triggers · malformed payloads · hallucinated tools · provider outages · credential redaction.
