import { AppError, redact, truncate } from "@nexus/shared";
import type { ToolCallBlock } from "@nexus/llm";
import {
  type ConfirmationService,
  type PermissionService,
  type ToolExecutor,
  type ToolRegistry,
  hashPayload,
  type ConfirmationRequest,
  type ToolContext,
  type ToolDefinition,
} from "@nexus/tools";
import type { AgentContext } from "./context.js";
import { type AgentEventEmitter } from "./events.js";
import type { ExecutionPolicy } from "./policy.js";
import type { Planner } from "./planner.js";
import type { AgentState, StopReason, ToolUsageRecord } from "./state.js";

export interface AgentLoopDeps {
  planner: Planner;
  registry: ToolRegistry;
  executor: ToolExecutor;
  permissions: PermissionService;
  confirmations: ConfirmationService;
  events: AgentEventEmitter;
  policy: ExecutionPolicy;
  now?: () => number;
}

export type LoopOutcome =
  | { kind: "terminal"; state: AgentState }
  | { kind: "suspended"; state: AgentState; confirmation: ConfirmationRequest };

type CallOutcome =
  | { kind: "continue" }
  | { kind: "suspend"; confirmation: ConfirmationRequest }
  | { kind: "stop"; stopReason: StopReason };

/**
 * Core agent loop.
 *
 * Sequence: observe -> reason -> decide -> authorize -> execute -> observe -> continue.
 */
export class AgentLoop {
  readonly #deps: AgentLoopDeps;
  readonly #now: () => number;

  constructor(deps: AgentLoopDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  async run(state: AgentState, context: AgentContext, signal: AbortSignal): Promise<LoopOutcome> {
    const { policy, events, planner } = this.#deps;

    state.record.status = "running";
    state.record.model = planner.model;

    for (;;) {
      // ── Loop Guards ──────────────────────────────────────────────────────
      if (signal.aborted) return this.#finish(state, context, "cancelled");
      if (this.#now() >= state.deadlineAt) return this.#finish(state, context, "global_timeout");
      if (state.record.iterations >= policy.maxIterations) {
        return this.#finish(state, context, "max_iterations");
      }
      if (state.consecutiveToolFailures >= policy.maxConsecutiveToolFailures) {
        return this.#finish(state, context, "tool_failure_limit");
      }

      state.record.iterations += 1;
      events.emit({
        type: "iteration.started",
        runId: state.record.runId,
        iteration: state.record.iterations,
        at: new Date(this.#now()).toISOString(),
      });

      // ── Reason ───────────────────────────────────────────────────────────
      let decision;
      try {
        const result = await planner.decide(context, signal, {
          userId: state.record.userId,
          conversationId: state.record.conversationId,
          runId: state.record.runId,
        });
        decision = result.decision;

        state.record.usage.inputTokens += result.response.usage.inputTokens;
        state.record.usage.outputTokens += result.response.usage.outputTokens;
        state.record.model = result.response.model;
        state.record.fallbackCount =
          (state.record.fallbackCount ?? 0) + (result.response.fallbackCount ?? 0);
        events.emit({
          type: "llm.completed",
          runId: state.record.runId,
          iteration: state.record.iterations,
          usage: result.response.usage,
          at: new Date(this.#now()).toISOString(),
        });
      } catch (error) {
        if (signal.aborted) return this.#finish(state, context, "cancelled");
        this.#recordError(state, error);
        return this.#finish(state, context, "provider_error");
      }

      context.addAssistantMessage(decision.message);
      state.messages = context.snapshot();

      // ── Final Answer ─────────────────────────────────────────────────────
      if (decision.kind === "final") {
        state.record.response = decision.text;
        events.emit({
          type: "agent.message",
          runId: state.record.runId,
          text: decision.text,
          at: new Date(this.#now()).toISOString(),
        });
        return this.#finish(state, context, "final_answer");
      }

      // ── Tool Calls ───────────────────────────────────────────────────────
      const outcome = await this.#processCalls(state, context, decision.calls, signal);
      state.messages = context.snapshot();

      if (outcome.kind === "suspend") {
        state.record.status = "waiting_for_confirmation";
        state.suspendedAt = this.#now();
        return { kind: "suspended", state, confirmation: outcome.confirmation };
      }
      if (outcome.kind === "stop") {
        return this.#finish(state, context, outcome.stopReason);
      }
    }
  }

  async #processCalls(
    state: AgentState,
    context: AgentContext,
    calls: readonly ToolCallBlock[],
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    for (const [index, call] of calls.entries()) {
      if (signal.aborted) return { kind: "stop", stopReason: "cancelled" };

      const outcome = await this.#processCall(state, context, call, signal);

      if (outcome.kind === "suspend") {
        state.pendingConfirmation = {
          confirmationId: outcome.confirmation.id,
          call,
          remainingCalls: calls.slice(index + 1),
        };
        return outcome;
      }
      if (outcome.kind === "stop") return outcome;
    }
    return { kind: "continue" };
  }

  async #processCall(
    state: AgentState,
    context: AgentContext,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const { registry, permissions, confirmations, policy, events } = this.#deps;

    // 1. Tool existence check.
    const tool = registry.get(call.name);
    if (tool === undefined) {
      this.#observeFailure(
        state,
        context,
        call,
        `Unknown tool: "${call.name}". Available tools: ${registry
          .list()
          .map((t) => t.name)
          .join(", ")}.`,
        { status: "failed", errorCode: "TOOL_NOT_FOUND", riskLevel: "SAFE" },
      );
      return { kind: "continue" };
    }

    // 2. Tool call budget check.
    if (state.toolCallCount >= policy.maxToolCalls) {
      return { kind: "stop", stopReason: "max_tool_calls" };
    }

    // 3. Arguments validation.
    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      this.#observeFailure(
        state,
        context,
        call,
        `Invalid arguments for "${call.name}": ${formatIssues(parsed.error.issues)}. Fix them and retry.`,
        { status: "failed", errorCode: "TOOL_INPUT_INVALID", riskLevel: tool.riskLevel },
      );
      return { kind: "continue" };
    }
    const input = parsed.data;

    // 4. Repetitive loop detection.
    const signature = `${call.name}:${hashPayload(parsed.data)}`;
    const seen = state.callSignatures.filter((s) => s === signature).length;
    if (seen >= policy.maxIdenticalToolCalls) {
      this.#observeFailure(
        state,
        context,
        call,
        `You have already called "${call.name}" ${String(seen)} times with identical arguments. Change your approach or respond with what you know.`,
        { status: "skipped", errorCode: "TOOL_LOOP_DETECTED", riskLevel: tool.riskLevel },
      );
      return { kind: "continue" };
    }
    state.callSignatures.push(signature);

    const toolContext = this.#toolContext(state, call, signal);

    // 5. Authorization check.
    const decision = await permissions.check(tool, input, {
      ...toolContext,
      attempt: 1,
      onProgress: () => undefined,
    });

    if (decision.effect === "deny") {
      events.emit({
        type: "tool.denied",
        runId: state.record.runId,
        toolCallId: call.id,
        name: call.name,
        reason: decision.reason,
        at: new Date(this.#now()).toISOString(),
      });
      this.#observeFailure(
        state,
        context,
        call,
        `Action denied: ${decision.reason} Explain this to the user; do not retry this tool.`,
        { status: "denied", errorCode: "PERMISSION_DENIED", riskLevel: tool.riskLevel },
      );
      return { kind: "continue" };
    }

    if (decision.effect === "confirm") {
      const confirmation = await confirmations.request({
        runId: state.record.runId,
        userId: state.record.userId,
        tool: tool.name,
        toolCallId: call.id,
        action: tool.summarize?.(input) ?? `${tool.name}`,
        description: truncate(JSON.stringify(redact(parsed.data), null, 2), 2_000),
        riskLevel: decision.riskLevel,
        payload: parsed.data,
      });

      events.emit({
        type: "confirmation.requested",
        runId: state.record.runId,
        request: confirmation,
        at: new Date(this.#now()).toISOString(),
      });

      return { kind: "suspend", confirmation };
    }

    // 6. Execution.
    await this.#executeAndObserve(state, context, tool, call, signal);
    return { kind: "continue" };
  }

  async executeApproved(
    state: AgentState,
    context: AgentContext,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<void> {
    const tool = this.#deps.registry.get(call.name);
    if (tool === undefined) {
      this.#observeFailure(state, context, call, `Unknown tool: "${call.name}".`, {
        status: "failed",
        errorCode: "TOOL_NOT_FOUND",
        riskLevel: "SAFE",
      });
      return;
    }
    await this.#executeAndObserve(state, context, tool, call, signal);
  }

  async #executeAndObserve(
    state: AgentState,
    context: AgentContext,
    tool: ToolDefinition<never, unknown>,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<void> {
    const { executor, events } = this.#deps;
    const toolContext = this.#toolContext(state, call, signal);

    events.emit({
      type: "tool.started",
      runId: state.record.runId,
      toolCallId: call.id,
      name: tool.name,
      riskLevel: tool.riskLevel,
      input: redact(call.arguments),
      at: new Date(this.#now()).toISOString(),
    });

    const result = await executor.execute(tool, call.arguments, {
      ...toolContext,
      onProgress: (progress) => {
        events.emit({
          type: "tool.progress",
          runId: state.record.runId,
          toolCallId: call.id,
          name: tool.name,
          pct: progress.pct,
          label: progress.label === undefined ? undefined : truncate(progress.label, 200),
          at: new Date(this.#now()).toISOString(),
        });
      },
    });
    state.toolCallCount += 1;

    events.emit({
      type: "tool.completed",
      runId: state.record.runId,
      toolCallId: call.id,
      name: tool.name,
      ok: result.ok,
      durationMs: result.metrics.durationMs,
      attempts: result.metrics.attempts,
      summary: truncate(result.summaryForModel, 500),
      at: new Date(this.#now()).toISOString(),
    });

    state.record.toolsUsed.push({
      toolCallId: call.id,
      name: tool.name,
      riskLevel: tool.riskLevel,
      status: result.ok ? "success" : "failed",
      durationMs: result.metrics.durationMs,
      attempts: result.metrics.attempts,
      input: redact(call.arguments),
      ...(result.ok ? {} : { errorCode: result.error.code }),
    });

    if (result.ok) {
      state.consecutiveToolFailures = 0;
    } else {
      state.consecutiveToolFailures += 1;
      state.record.errors.push({
        at: new Date(this.#now()).toISOString(),
        code: result.error.code,
        message: result.error.message,
        iteration: state.record.iterations,
      });
    }

    context.addToolResult(call, result.summaryForModel, !result.ok);
  }

  #observeFailure(
    state: AgentState,
    context: AgentContext,
    call: ToolCallBlock,
    observation: string,
    meta: {
      status: ToolUsageRecord["status"];
      errorCode: string;
      riskLevel: ToolUsageRecord["riskLevel"];
    },
  ): void {
    state.record.toolsUsed.push({
      toolCallId: call.id,
      name: call.name,
      riskLevel: meta.riskLevel,
      status: meta.status,
      durationMs: 0,
      attempts: 0,
      input: redact(call.arguments),
      errorCode: meta.errorCode,
    });
    state.record.errors.push({
      at: new Date(this.#now()).toISOString(),
      code: meta.errorCode,
      message: observation,
      iteration: state.record.iterations,
    });
    if (meta.status === "failed") state.consecutiveToolFailures += 1;

    context.addToolResult(call, observation, true);
  }

  #toolContext(
    state: AgentState,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Omit<ToolContext, "attempt" | "onProgress"> {
    return {
      runId: state.record.runId,
      userId: state.record.userId,
      conversationId: state.record.conversationId,
      correlationId: state.record.correlationId,
      signal,
      idempotencyKey: `${state.record.runId}:${String(state.record.iterations)}:${call.name}:${hashPayload(call.arguments)}`,
    };
  }

  #recordError(state: AgentState, error: unknown): void {
    const appError = error instanceof AppError ? error : undefined;
    state.record.errors.push({
      at: new Date(this.#now()).toISOString(),
      code: appError?.code ?? "INTERNAL_ERROR",
      message: appError?.userMessage ?? (error instanceof Error ? error.message : String(error)),
      iteration: state.record.iterations,
    });
  }

  #finish(state: AgentState, context: AgentContext, stopReason: StopReason): LoopOutcome {
    state.messages = context.snapshot();
    state.record.stopReason = stopReason;
    state.record.endTime = new Date(this.#now()).toISOString();
    state.pendingConfirmation = null;
    state.suspendedAt = null;

    switch (stopReason) {
      case "final_answer":
        state.record.status = "completed";
        break;
      case "cancelled":
        state.record.status = "cancelled";
        state.record.response ??= "Task cancelled.";
        break;
      case "provider_error":
      case "internal_error":
        state.record.status = "failed";
        state.record.response ??=
          "I could not complete the task: the model generation service failed.";
        break;
      default:
        state.record.status = "incomplete";
        state.record.response = this.#partialSummary(state, stopReason);
        break;
    }

    this.#deps.events.emit({
      type: "run.finished",
      runId: state.record.runId,
      status: state.record.status,
      stopReason,
      at: state.record.endTime,
    });

    return { kind: "terminal", state };
  }

  #partialSummary(state: AgentState, stopReason: StopReason): string {
    const reasons: Record<string, string> = {
      max_iterations: "maximum step limit reached",
      max_tool_calls: "maximum tool call limit reached",
      global_timeout: "allocated time elapsed",
      tool_failure_limit: "too many consecutive tool failures",
      confirmation_rejected: "the requested action was rejected",
      confirmation_expired: "the confirmation request expired",
    };
    const why = reasons[stopReason] ?? "stopped before completion";

    const succeeded = state.record.toolsUsed.filter((t) => t.status === "success");
    const failed = state.record.toolsUsed.filter((t) => t.status !== "success");

    const parts = [`I could not complete the task: ${why}.`];
    if (succeeded.length > 0) {
      parts.push(`Completed: ${succeeded.map((t) => t.name).join(", ")}.`);
    }
    if (failed.length > 0) {
      parts.push(
        `Failed: ${failed.map((t) => `${t.name} (${t.errorCode ?? "error"})`).join(", ")}.`,
      );
    }
    const lastText = lastAssistantText(state);
    if (lastText !== undefined && lastText.trim().length > 0) {
      parts.push(`Findings: ${truncate(lastText.trim(), 800)}`);
    }
    return parts.join(" ");
  }
}

function lastAssistantText(state: AgentState): string | undefined {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.length > 0) return text;
  }
  return undefined;
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"} — ${issue.message}`)
    .join("; ");
}
