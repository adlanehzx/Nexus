import type { ToolContext, ToolDefinition } from "./definition.js";
import { toolRequiresConfirmation } from "./definition.js";
import { missingPermissions } from "./permissions.js";
import { maxRisk, riskAtLeast, riskRank, type RiskLevel } from "./risk.js";

/**
 * Authorization verdict.
 */
export type PermissionDecision =
  | { effect: "allow" }
  | { effect: "confirm"; riskLevel: RiskLevel; reason: string }
  | { effect: "deny"; reason: string; missing: readonly string[] };

/** Source of granted user permissions. */
export interface GrantProvider {
  listGranted(userId: string): Promise<readonly string[]>;
}

export class StaticGrantProvider implements GrantProvider {
  readonly #byUser: Map<string, readonly string[]>;
  readonly #fallback: readonly string[];

  constructor(grants: readonly string[] | Record<string, readonly string[]>) {
    if (Array.isArray(grants)) {
      this.#byUser = new Map();
      this.#fallback = grants;
    } else {
      this.#byUser = new Map(Object.entries(grants as Record<string, readonly string[]>));
      this.#fallback = [];
    }
  }

  listGranted(userId: string): Promise<readonly string[]> {
    return Promise.resolve(this.#byUser.get(userId) ?? this.#fallback);
  }
}

export interface PermissionServiceOptions {
  grants: GrantProvider;
  autoApproveMaxRisk?: RiskLevel;
  readOnly?: boolean | (() => boolean);
}

/**
 * Tool authorization and permission enforcement service.
 * Closed posture: denial by default.
 */
export class PermissionService {
  readonly #grants: GrantProvider;
  readonly #autoApproveMaxRisk: RiskLevel;
  readonly #readOnly: () => boolean;

  constructor(options: PermissionServiceOptions) {
    this.#grants = options.grants;
    this.#autoApproveMaxRisk = options.autoApproveMaxRisk ?? "LOW";
    const readOnly = options.readOnly ?? false;
    this.#readOnly = typeof readOnly === "function" ? readOnly : () => readOnly;
  }

  async listGranted(userId: string): Promise<readonly string[]> {
    return this.#grants.listGranted(userId);
  }

  /**
   * Evaluates authorization in fixed priority order:
   * circuit breaker -> missing permissions -> CRITICAL enforcement -> confirmation requirement -> risk threshold.
   */
  async check<I, O>(
    tool: ToolDefinition<I, O>,
    input: I,
    context: ToolContext,
  ): Promise<PermissionDecision> {
    // 1. Global read-only circuit breaker.
    if (this.#readOnly() && riskAtLeast(tool.riskLevel, "LOW")) {
      return {
        effect: "deny",
        reason: "NEXUS is paused: only read-only actions without side effects are allowed.",
        missing: [],
      };
    }

    // 2. Missing permissions check.
    const granted = await this.#grants.listGranted(context.userId);
    const missing = missingPermissions(granted, tool.requiredPermissions);
    if (missing.length > 0) {
      return {
        effect: "deny",
        reason: `Missing permissions: ${missing.join(", ")}.`,
        missing,
      };
    }

    // 3. CRITICAL risk actions strictly require confirmation regardless of tool declaration.
    if (tool.riskLevel === "CRITICAL") {
      return {
        effect: "confirm",
        riskLevel: "CRITICAL",
        reason: "Irreversible action: explicit confirmation required.",
      };
    }

    // 4. Tool-declared confirmation requirement (may depend on input arguments).
    if (toolRequiresConfirmation(tool, input, context)) {
      return {
        effect: "confirm",
        riskLevel: maxRisk(tool.riskLevel, "MEDIUM"),
        reason: "This action produces external side-effects.",
      };
    }

    // 5. Check against auto-approval risk threshold.
    if (riskRank(tool.riskLevel) > riskRank(this.#autoApproveMaxRisk)) {
      return {
        effect: "confirm",
        riskLevel: tool.riskLevel,
        reason: `Risk ${tool.riskLevel} exceeds auto-approval threshold (${this.#autoApproveMaxRisk}).`,
      };
    }

    return { effect: "allow" };
  }
}
