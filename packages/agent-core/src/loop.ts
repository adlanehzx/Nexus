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
  /** Injectée pour rendre les tests de délai déterministes. */
  now?: () => number;
}

/**
 * Issue d'un passage dans la boucle.
 *
 * `suspended` n'est pas un échec : c'est l'état normal d'un agent qui attend un
 * accord humain. Le worker est libéré, l'état est persisté, la reprise repart
 * exactement d'ici.
 */
export type LoopOutcome =
  | { kind: "terminal"; state: AgentState }
  | { kind: "suspended"; state: AgentState; confirmation: ConfirmationRequest };

/** Ce que fait la boucle d'un appel d'outil donné. */
type CallOutcome =
  | { kind: "continue" }
  | { kind: "suspend"; confirmation: ConfirmationRequest }
  | { kind: "stop"; stopReason: StopReason };

/**
 * Boucle agentique.
 *
 * observer → raisonner → décider → autoriser → exécuter → observer → continuer.
 *
 * Deux propriétés valent d'être soulignées, parce qu'elles conditionnent tout
 * le reste :
 *
 *  1. **Un appel d'outil ne vient que d'un bloc structuré.** Aucun texte n'est
 *     analysé pour en déduire une action.
 *  2. **Un échec n'est pas un plantage.** Outil inconnu, arguments invalides,
 *     permission refusée, exécution ratée : tout redevient une observation que
 *     le modèle peut traiter au tour suivant. La boucle ne s'arrête que sur un
 *     budget épuisé, une annulation, ou une panne du fournisseur.
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
      // ── Gardes de boucle ────────────────────────────────────────────────
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

      // ── Raisonner ───────────────────────────────────────────────────────
      let decision;
      try {
        const result = await planner.decide(context, signal);
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

      // ── Réponse finale ? ────────────────────────────────────────────────
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

      // ── Appels d'outils ─────────────────────────────────────────────────
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

  /**
   * Traite une série d'appels séquentiellement.
   *
   * Séquentiel et non parallèle : deux appels du même tour peuvent avoir des
   * effets de bord qui interagissent, et une confirmation au milieu doit
   * suspendre le reste plutôt que de laisser filer les suivants.
   */
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

  /** Un appel : résoudre, valider, autoriser, exécuter, observer. */
  async #processCall(
    state: AgentState,
    context: AgentContext,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const { registry, permissions, confirmations, policy, events } = this.#deps;

    // 1. L'outil existe-t-il ? Un nom halluciné devient une observation, pas
    //    une exception : le modèle peut corriger au tour suivant.
    const tool = registry.get(call.name);
    if (tool === undefined) {
      this.#observeFailure(
        state,
        context,
        call,
        `Outil inconnu : « ${call.name} ». Outils disponibles : ${registry
          .list()
          .map((t) => t.name)
          .join(", ")}.`,
        { status: "failed", errorCode: "TOOL_NOT_FOUND", riskLevel: "SAFE" },
      );
      return { kind: "continue" };
    }

    // 2. Budget d'appels d'outils.
    if (state.toolCallCount >= policy.maxToolCalls) {
      return { kind: "stop", stopReason: "max_tool_calls" };
    }

    // 3. Validation des arguments. On la fait ici — et pas seulement dans
    //    l'exécuteur — parce que `requiresConfirmation` et l'aperçu de la carte
    //    de confirmation ont besoin d'arguments typés.
    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      this.#observeFailure(
        state,
        context,
        call,
        `Arguments invalides pour « ${call.name} » : ${formatIssues(parsed.error.issues)}. Corrige-les et réessaie.`,
        { status: "failed", errorCode: "TOOL_INPUT_INVALID", riskLevel: tool.riskLevel },
      );
      return { kind: "continue" };
    }
    const input = parsed.data;

    // 4. Anti-boucle : le même outil, les mêmes arguments, encore et encore.
    const signature = `${call.name}:${hashPayload(parsed.data)}`;
    const seen = state.callSignatures.filter((s) => s === signature).length;
    if (seen >= policy.maxIdenticalToolCalls) {
      this.#observeFailure(
        state,
        context,
        call,
        `Tu as déjà appelé « ${call.name} » ${String(seen)} fois avec exactement les mêmes arguments. Change d'approche ou réponds avec ce que tu sais.`,
        { status: "skipped", errorCode: "TOOL_LOOP_DETECTED", riskLevel: tool.riskLevel },
      );
      return { kind: "continue" };
    }
    state.callSignatures.push(signature);

    const toolContext = this.#toolContext(state, call, signal);

    // 5. Autorisation.
    // L'évaluation des permissions n'exécute rien : elle n'a pas de progression
    // à publier, d'où le canal inerte.
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
        `Action refusée : ${decision.reason} Explique-le à l'utilisateur ; ne réessaie pas cet outil.`,
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
        // L'aperçu est construit à partir des arguments VALIDÉS, jamais d'un
        // résumé produit par le modèle : c'est ce qui garantit que l'utilisateur
        // approuve ce qui va réellement se passer.
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

    // 6. Exécution.
    await this.#executeAndObserve(state, context, tool, call, signal);
    return { kind: "continue" };
  }

  /**
   * Exécute un appel déjà autorisé et réinjecte le résultat.
   * Utilisée par la boucle et par la reprise après confirmation.
   */
  async executeApproved(
    state: AgentState,
    context: AgentContext,
    call: ToolCallBlock,
    signal: AbortSignal,
  ): Promise<void> {
    const tool = this.#deps.registry.get(call.name);
    if (tool === undefined) {
      this.#observeFailure(state, context, call, `Outil inconnu : « ${call.name} ».`, {
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
      // La progression d'un outil long remonte telle quelle : c'est ce qui
      // permettra à l'interface de montrer ce que fait le navigateur, plutôt
      // qu'un sablier.
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

  /** Enregistre un échec qui n'a pas atteint l'exécuteur et le réinjecte. */
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
    // Un refus de permission ne compte pas comme une panne : il n'a pas
    // vocation à déclencher la limite d'échecs consécutifs.
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

  /** Clôt le run et fixe la réponse rendue à l'utilisateur. */
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
        state.record.response ??= "Tâche annulée.";
        break;
      case "provider_error":
      case "internal_error":
        state.record.status = "failed";
        state.record.response ??= "Je n'ai pas pu terminer : le service de génération a échoué.";
        break;
      default:
        // Budget épuisé. L'agent DOIT dire ce qu'il a fait et ce qui reste —
        // s'arrêter en silence est un défaut produit, pas un cas limite.
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
      max_iterations: "j'ai atteint le nombre maximal d'étapes",
      max_tool_calls: "j'ai atteint le nombre maximal d'actions",
      global_timeout: "le délai imparti est écoulé",
      tool_failure_limit: "trop d'outils ont échoué d'affilée",
      confirmation_rejected: "tu as refusé l'action demandée",
      confirmation_expired: "la demande de confirmation a expiré",
    };
    const why = reasons[stopReason] ?? "je me suis arrêté avant la fin";

    const succeeded = state.record.toolsUsed.filter((t) => t.status === "success");
    const failed = state.record.toolsUsed.filter((t) => t.status !== "success");

    const parts = [`Je n'ai pas pu terminer : ${why}.`];
    if (succeeded.length > 0) {
      parts.push(`Effectué : ${succeeded.map((t) => t.name).join(", ")}.`);
    }
    if (failed.length > 0) {
      parts.push(
        `En échec : ${failed.map((t) => `${t.name} (${t.errorCode ?? "erreur"})`).join(", ")}.`,
      );
    }
    // Le dernier texte du modèle porte souvent l'essentiel de ce qu'il a appris.
    const lastText = lastAssistantText(state);
    if (lastText !== undefined && lastText.trim().length > 0) {
      parts.push(`Ce que j'ai trouvé : ${truncate(lastText.trim(), 800)}`);
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
    .map((issue) => `${issue.path.map(String).join(".") || "(racine)"} — ${issue.message}`)
    .join(" ; ");
}
