/**
 * NEXUS Unified Agent Runtime - Secure Execution Engine
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { redact } from "@nexus/shared";
import type { RiskLevel } from "@nexus/tools";
import type { ProviderSession, ProviderTurnStreamEvent } from "./providers/types.js";
import {
  ToolSecurityPolicyEvaluator,
  type SecurityEvaluation,
  type HumanConfirmationRequest,
} from "./runtime-security.js";

export interface UnifiedRuntimeOptions {
  workspaceRoot: string;
  autoApproveMaxRisk?: RiskLevel;
  onConfirmationRequired?: (request: HumanConfirmationRequest) => Promise<boolean>;
  onAuditLog?: (entry: Record<string, unknown>) => void;
  toolExecutor?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export class UnifiedAgentRuntime {
  private readonly session: ProviderSession;
  private readonly securityEvaluator: ToolSecurityPolicyEvaluator;
  private readonly options: UnifiedRuntimeOptions;

  constructor(session: ProviderSession, options: UnifiedRuntimeOptions) {
    this.session = session;
    this.options = options;
    this.securityEvaluator = new ToolSecurityPolicyEvaluator(
      options.workspaceRoot,
      options.autoApproveMaxRisk ?? "LOW",
    );
  }

  async *executeTurn(
    prompt: string,
    attachments: string[] = [],
  ): AsyncIterable<ProviderTurnStreamEvent> {
    const authorizedCallIds = new Set<string>();
    const pendingArgsDelta = new Map<string, { toolName: string; rawArgs: string }>();

    for await (const event of this.session.sendPrompt(prompt, attachments)) {
      // 1. Tool Call Start: Authorization MUST occur before any tool execution
      if (event.type === "tool-call-start") {
        if (event.args) {
          const evalResult = await this.evaluateAndAuthorize(
            event.callId,
            event.toolName,
            event.args,
          );
          if (!evalResult.authorized) {
            yield {
              type: "error",
              message: evalResult.error ?? "Tool execution denied by policy",
              recoverable: true,
            };
            continue;
          }
          authorizedCallIds.add(event.callId);

          // If toolExecutor is attached, execute the tool securely now
          if (this.options.toolExecutor) {
            yield event;
            try {
              const result = await this.options.toolExecutor(event.toolName, event.args);
              this.logAudit(event.toolName, event.args);
              yield {
                type: "tool-call-complete",
                callId: event.callId,
                toolName: event.toolName,
                args: event.args,
                result,
              };
            } catch (err) {
              yield {
                type: "error",
                message: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
                recoverable: true,
              };
            }
            continue;
          }
        } else {
          pendingArgsDelta.set(event.callId, { toolName: event.toolName, rawArgs: "" });
        }

        yield event;
        continue;
      }

      // 2. Accumulate streaming tool arguments
      if (event.type === "tool-call-delta") {
        const pending = pendingArgsDelta.get(event.callId);
        if (pending) {
          pending.rawArgs += event.argsDelta;
        }
        yield event;
        continue;
      }

      // 3. Tool Call Complete: Verify authorization prior to accepting any tool effects
      if (event.type === "tool-call-complete") {
        if (!authorizedCallIds.has(event.callId)) {
          // If not pre-authorized, evaluate strictly NOW before yielding or accepting
          const evalResult = await this.evaluateAndAuthorize(
            event.callId,
            event.toolName,
            event.args,
          );
          if (!evalResult.authorized) {
            yield {
              type: "error",
              message: `Unauthorized tool execution blocked: ${evalResult.error}`,
              recoverable: true,
            };
            continue;
          }
          authorizedCallIds.add(event.callId);
        }

        this.logAudit(event.toolName, event.args);
        yield event;
        continue;
      }

      yield event;
    }
  }

  private async evaluateAndAuthorize(
    _callId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ authorized: boolean; error?: string }> {
    const evaluation: SecurityEvaluation = this.securityEvaluator.evaluateToolCall(
      toolName,
      args,
      "MEDIUM",
    );

    if (evaluation.disposition === "deny") {
      return {
        authorized: false,
        error: `Tool '${toolName}' denied: ${evaluation.reason}`,
      };
    }

    if (evaluation.disposition === "ask" && evaluation.confirmationRequest) {
      if (!this.options.onConfirmationRequired) {
        return {
          authorized: false,
          error: `Approval required for tool '${toolName}' but no confirmation handler registered: ${evaluation.reason}`,
        };
      }

      const approved = await this.options.onConfirmationRequired(evaluation.confirmationRequest);
      if (!approved) {
        return {
          authorized: false,
          error: `Tool execution '${toolName}' cancelled by user confirmation policy`,
        };
      }
    }

    return { authorized: true };
  }

  private logAudit(toolName: string, args: Record<string, unknown>): void {
    this.options.onAuditLog?.({
      sessionId: this.session.id,
      provider: this.session.providerType,
      model: this.session.modelId,
      toolName,
      args: redact(args),
      timestamp: new Date().toISOString(),
    });
  }

  async interrupt(): Promise<void> {
    await this.session.interrupt();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
