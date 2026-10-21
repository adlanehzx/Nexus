# 16 — Agent Core (Implemented Architecture)

This document describes the engine **as built in the codebase**, supplementing [03 — Agent Architecture](03-agent.md),
which details the initial design. In case of discrepancies, this document reflects current implementation.

Packages: [`@nexus/agent-core`](../../packages/agent-core), [`@nexus/tools`](../../packages/tools),
[`@nexus/llm`](../../packages/llm), [`@nexus/memory`](../../packages/memory).

## 1. Actual Package Decomposition

The specifications defined eleven modular components, mapped cleanly across architecture layers
([00 §4](00-overview.md)) — capability modules know nothing of LLMs, reasoning layers know nothing
of low-level tool executions:

| Component             | Location                            | Architecture Plane  |
| --------------------- | ----------------------------------- | ------------------- |
| `AgentOrchestrator`   | `agent-core/src/orchestrator.ts`    | Reasoning           |
| `AgentLoop`           | `agent-core/src/loop.ts`            | Reasoning           |
| `AgentContext`        | `agent-core/src/context.ts`         | Reasoning           |
| `AgentState`          | `agent-core/src/state.ts`           | Reasoning           |
| `Planner`             | `agent-core/src/planner.ts`         | Reasoning           |
| `ExecutionPolicy`     | `agent-core/src/policy.ts`          | Governance          |
| `ToolRegistry`        | `tools/src/registry.ts`             | Capability          |
| `ToolExecutor`        | `tools/src/executor.ts`             | Capability          |
| `PermissionService`   | `tools/src/permission-service.ts`   | Governance          |
| `ConfirmationService` | `tools/src/confirmation-service.ts` | Governance          |
| `ToolDefinition`      | `tools/src/definition.ts`           | Capability          |

`agent-core` depends neither on `@nexus/database`, nor on MCP packages, nor on vendor SDKs.
It interacts exclusively through decoupled ports: `LLMProvider`, `MemoryProvider`, `AgentRunStore`.
This makes the core testable in isolation without network or database dependencies.

## 2. Five-Tier Risk Hierarchy

Initial specifications suggested three tiers (`SAFE` / `CONFIRM` / `CRITICAL`).
The implementation adopts **five granular tiers**: `SAFE < LOW < MEDIUM < HIGH < CRITICAL`.

This refinement prevents confirmation fatigue ([R3](../RISKS.md)). With only three tiers, "write a note
in my local scratchpad" and "send an email to an external contact" fell into the identical bucket,
prompting the same modal dialog. Five tiers introduce an **auto-approval risk ceiling** (`autoApproveMaxRisk`,
`LOW` by default) cleanly separating these cases.

The escalation rule remains strictly enforced: risk can only escalate, never downgrade. A `CRITICAL`
tool always mandates explicit confirmation, even if configured with `requiresConfirmation: false` — a
tool definition cannot exempt itself from human authorization on irreversible mutations.

Mapping details are found in [09 §3](09-security-permissions.md).

## 3. Tool Calls Derive Strictly from Structured Blocks

`Planner.decide()` parses structured `tool_call` blocks emitted by the provider adapter. Zero regex
string scraping across prose text. Input schemas derive from Zod via `z.toJSONSchema` and are passed to
the provider; argument payloads arrive pre-deserialized.

Verified in automated test suites: an agent cannot execute an action hallucinated inside prose commentary.
If a model describes an action in natural language without emitting a structured tool block, the loop
treats it as text output, preventing unintended side effects.

## 4. Run Suspension and Resumption

`waiting_for_confirmation` is an explicit persisted state, not an in-memory process lock.

```
run() ─▶ … ─▶ PermissionService: CONFIRM
              ConfirmationService.request()  → payloadHash, single-use nonce
              state.pendingConfirmation = { confirmationId, call, remainingCalls }
              state.suspendedAt = now
              store.save(state)              → Worker process is FREED
                     ⋮  (minutes / hours)
resume(runId, "approved")
              deadlineAt += now - suspendedAt        ← Human response time restored
              confirmations.resolve()                 → Check expiration & duplicate resolutions
              matchesPayload(call.arguments)          → If mismatch: DENIED
              executeApproved() and agent loop resumes
```

Four architectural guarantees:

1. **Workers never block** waiting on human review.
2. **`payloadHash`** cryptographically binds approval to exact evaluated arguments. Any post-approval
   argument manipulation invalidates the grant.
3. **Expired requests are never auto-approved**, and an already resolved request cannot be replayed.
4. **Denial terminates sibling calls** in the same turn: if a user rejects one call in a batch,
   executing subsequent dependent tools would be incorrect.

## 5. Loop Termination Conditions

The loop halts exclusively on these conditions:

| Cause                                     | Status       | `stopReason`                                           |
| ----------------------------------------- | ------------ | ------------------------------------------------------ |
| Final model answer emitted                | `completed`  | `final_answer`                                         |
| Iteration, tool, or wall-clock budget hit | `incomplete` | `max_iterations` · `max_tool_calls` · `global_timeout` |
| Consecutive tool execution failure limit  | `incomplete` | `tool_failure_limit`                                   |
| Confirmation prompt rejected or expired   | `incomplete` | `confirmation_rejected` · `confirmation_expired`       |
| User cancellation                         | `cancelled`  | `cancelled`                                            |
| Provider infrastructure outage            | `failed`     | `provider_error`                                       |

All other conditions — missing tools, invalid arguments, denied permissions, execution errors, schema
mismatches, detected loops — are **re-injected as tool observations** to the model. This enables the
agent to adapt and self-correct rather than crashing.

Upon budget exhaustion, `#partialSummary()` constructs a deterministic summary: termination reason,
successful steps, failed actions, and latest model state.

## 6. Execution Reliability

- **Enforced Timeouts**: `ToolExecutor` races execution against `AbortSignal` (`Promise.race`): tools
  ignoring signals are forcefully terminated. Tested using simulated non-terminating tools.
- **Cancellation vs. Timeout**: Signals are tracked distinctly; user intent always takes precedence.
- **Targeted Retries**: Only errors explicitly declared `retryable` are retried. Raw tool errors are
  **not** retried by default to prevent duplicate actions (e.g. sending duplicate emails). Transient
  failures are flagged using `RetryableToolError`.
- **Non-idempotent tools are never automatically retried**.
- **Exponential backoff with upper-half jitter** to avoid thundering herd issues without sacrificing
  retry progression.

## 7. Data Redaction

`redact()` runs before any payload enters audit logs, traces, or event streams. Evaluated in two stages:

- By **Key Name**: `password`, `token`, `apiKey`, `authorization`, `client_secret`, `private_key`…;
- By **Value Pattern**: `sk-…`, `ghp_…`, JWT tokens, `Bearer …`, PEM private key blocks.

This prevents credentials from leaking when placed inside generically named fields like `value`.
Tests verify that passwords passed as tool arguments appear neither in `AgentRunRecord` nor in emitted events.

## 8. Intentional Refinements from Initial Design (Doc 03)

| Dimension              | Document 03             | Implemented Code                              | Justification                                                                                      |
| ---------------------- | ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Risk Tiers             | 3 levels                | 5 levels                                      | Introduces auto-approval risk thresholds (§2)                                                      |
| Persistence            | Direct Prisma in loop   | Port interface + memory implementation        | `agent-core` remains decoupled from `@nexus/database` (ADR-003)                                     |
| Planner                | `PLANNED` with `Task`   | Reactive mode primary                         | Planned mode integrates alongside task engine (Phase 6); reactive loop satisfies Phase 2 use cases |
| Streaming              | Tokens into WebSocket   | `stream()` available, loop uses `generate()`  | WebSocket streaming handled at gateway layer                                                       |
| Compaction             | Embedded in loop        | Modular architecture                         | Extracted to dedicated `ContextAssembler`                                                          |
| Tool `execute()`       | Returns `ToolResult`    | Returns output or **throws**                  | Developers write standard throwing code; executor wraps results consistently                       |

## 9. Automated Test Coverage

124 tests in the monorepo, including 43 covering `agent-core` and 37 for `tools`.

The only mock dependency is the model (`ScriptedLLMProvider`), alongside backoff clock timers —
recorded without thread sleeps for exact assertions. Registries, permissions, confirmations, executors,
loops, and state stores run real code, verifying successful executions, timeouts, cancellations, and
error handling.
