export type EngineTransport = "local" | "cloud" | "acp";
export type PrivacyClass = "local_only" | "private_cloud" | "external_cloud";

export interface EngineDescriptor {
  id: string;
  transport: EngineTransport;
  quality: number;
  latencyMs: number;
  /** Official or configured marginal cost. Null means unknown. */
  costPerMillionTokens: number | null;
  maxContextTokens: number;
  privacy: PrivacyClass;
  /** Official remaining quota percentage. Null means unknown, never unlimited. */
  quotaRemainingPercent: number | null;
  available: boolean;
}

export interface RoutingRequirements {
  requiredContextTokens: number;
  minimumQuality?: number;
  maximumLatencyMs?: number;
  maximumCostPerMillionTokens?: number;
  privacy: PrivacyClass;
}

export interface EngineRoutingDecision {
  selectedEngineId: string | null;
  orderedEngineIds: string[];
  rejected: Record<string, string[]>;
  scores: Record<string, number>;
  quotaStates: Record<string, number | "unknown">;
}

const PRIVACY_RANK: Record<PrivacyClass, number> = {
  local_only: 3,
  private_cloud: 2,
  external_cloud: 1,
};

/** Deterministic provider-neutral routing by quality, latency, cost, context, privacy, and quota. */
export function routeEngines(
  engines: readonly EngineDescriptor[],
  requirements: RoutingRequirements,
): EngineRoutingDecision {
  const rejected: Record<string, string[]> = {};
  const scores: Record<string, number> = {};
  const quotaStates: Record<string, number | "unknown"> = {};

  for (const engine of engines) {
    const reasons: string[] = [];
    quotaStates[engine.id] = engine.quotaRemainingPercent ?? "unknown";
    if (!engine.available) reasons.push("unavailable");
    if (engine.quotaRemainingPercent === 0) reasons.push("quota_exhausted");
    if (engine.maxContextTokens < requirements.requiredContextTokens) {
      reasons.push("context_too_small");
    }
    if (engine.quality < (requirements.minimumQuality ?? 0)) reasons.push("quality_too_low");
    if (engine.latencyMs > (requirements.maximumLatencyMs ?? Number.POSITIVE_INFINITY)) {
      reasons.push("latency_too_high");
    }
    if (
      engine.costPerMillionTokens !== null &&
      engine.costPerMillionTokens >
        (requirements.maximumCostPerMillionTokens ?? Number.POSITIVE_INFINITY)
    ) {
      reasons.push("cost_too_high");
    }
    if (PRIVACY_RANK[engine.privacy] < PRIVACY_RANK[requirements.privacy]) {
      reasons.push("privacy_boundary");
    }
    if (reasons.length > 0) {
      rejected[engine.id] = reasons;
      continue;
    }

    const latencyScore = Math.max(0, 100 - engine.latencyMs / 20);
    const costScore =
      engine.costPerMillionTokens === null
        ? 50
        : Math.max(0, 100 - engine.costPerMillionTokens * 2);
    // Unknown quota is neutral. It is deliberately not scored as 100/unlimited.
    const quotaScore = engine.quotaRemainingPercent ?? 50;
    const privacyScore = PRIVACY_RANK[engine.privacy] * 20;
    scores[engine.id] = Number(
      (
        engine.quality * 0.4 +
        latencyScore * 0.15 +
        costScore * 0.15 +
        quotaScore * 0.15 +
        privacyScore * 0.15
      ).toFixed(4),
    );
  }

  const orderedEngineIds = Object.keys(scores).sort(
    (left, right) => (scores[right] ?? 0) - (scores[left] ?? 0) || left.localeCompare(right),
  );
  return {
    selectedEngineId: orderedEngineIds[0] ?? null,
    orderedEngineIds,
    rejected,
    scores,
    quotaStates,
  };
}

export interface RoutingDecisionStore {
  persist(input: {
    taskId: string;
    boundary: number;
    decision: EngineRoutingDecision;
  }): Promise<void>;
}

export class TaskBoundaryEngineRouter {
  private readonly store: RoutingDecisionStore;

  constructor(store: RoutingDecisionStore) {
    this.store = store;
  }

  async select(
    taskId: string,
    boundary: number,
    engines: readonly EngineDescriptor[],
    requirements: RoutingRequirements,
  ): Promise<EngineRoutingDecision> {
    if (!taskId || !Number.isInteger(boundary) || boundary < 0) {
      throw new Error("Engine migration requires a persisted task boundary");
    }
    const decision = routeEngines(engines, requirements);
    await this.store.persist({ taskId, boundary, decision });
    return decision;
  }
}
