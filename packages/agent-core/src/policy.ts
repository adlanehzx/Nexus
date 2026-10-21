import type { RiskLevel, RetryPolicy } from "@nexus/tools";

/**
 * Execution policy budgets and constraints.
 */
export interface ExecutionPolicy {
  /** Maximum number of model reasoning iterations. */
  maxIterations: number;
  /** Global run timeout in ms, excluding human confirmation latency. */
  globalTimeoutMs: number;
  /** Default timeout per tool attempt when unspecified by tool definition. */
  defaultToolTimeoutMs: number;
  retry: RetryPolicy;
  /** Maximum consecutive tool failures allowed before aborting loop. */
  maxConsecutiveToolFailures: number;
  /** Maximum identical tool invocations with identical arguments allowed. */
  maxIdenticalToolCalls: number;
  /** Maximum total tool invocations across the run. */
  maxToolCalls: number;
  /** Maximum risk level executed without human confirmation. */
  autoApproveMaxRisk: RiskLevel;
  /** Token budget per model completion. */
  maxTokensPerCall: number;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  maxIterations: 12,
  globalTimeoutMs: 180_000,
  defaultToolTimeoutMs: 30_000,
  retry: { attempts: 3, initialDelayMs: 200, maxDelayMs: 5_000, factor: 2, jitter: true },
  maxConsecutiveToolFailures: 3,
  maxIdenticalToolCalls: 2,
  maxToolCalls: 25,
  autoApproveMaxRisk: "LOW",
  maxTokensPerCall: 16_000,
};

export function resolvePolicy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    ...overrides,
    retry: { ...DEFAULT_EXECUTION_POLICY.retry, ...overrides?.retry },
  };
}
