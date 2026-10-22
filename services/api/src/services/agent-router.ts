import { z } from "zod";
import type { RuntimeConfigurationStore } from "./runtime-configuration.js";
import type { ProviderAccountService } from "./provider-accounts.js";

export const TASK_CATEGORIES = [
  "code",
  "research",
  "review",
  "browser",
  "synthesis",
  "general",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const taskCategorySchema = z.enum(TASK_CATEGORIES);

export const categoryStatsSchema = z.object({
  runs: z.number().int().nonnegative().default(0),
  successes: z.number().int().nonnegative().default(0),
  failures: z.number().int().nonnegative().default(0),
  avgDurationMs: z.number().nonnegative().default(0),
  qualitySum: z.number().nonnegative().default(0),
});
export type CategoryStats = z.infer<typeof categoryStatsSchema>;

export const agentRoutingStatsSchema = z.record(
  z.string(),
  z.object({
    categories: z.record(z.string(), categoryStatsSchema).default({}),
    totalRuns: z.number().int().nonnegative().default(0),
    overallSuccessRate: z.number().min(0).max(1).default(1.0),
    updatedAt: z.string(),
  }),
);
export type AgentRoutingStats = Record<
  string,
  {
    categories: Record<string, CategoryStats>;
    totalRuns: number;
    overallSuccessRate: number;
    updatedAt: string;
  }
>;

export interface TaskClassification {
  primaryCategory: TaskCategory;
  categoryWeights: Record<TaskCategory, number>;
  requiresBrowser: boolean;
  estimatedComplexity: "low" | "medium" | "high";
  contextChars: number;
}

export interface AgentScoreBreakdown {
  compatibility: number;
  authentication: number;
  quota: number;
  health: number;
  quality: number;
  performance: number;
  context: number;
}

export interface RankedAgent {
  key: string;
  totalScore: number;
  isAvailable: boolean;
  unavailabilityReason?: string | undefined;
  breakdown: AgentScoreBreakdown;
  recommendedCategory: TaskCategory;
}

export interface RoutingMatrixItem {
  key: string;
  categoryScores: Record<TaskCategory, number>;
  totalRuns: number;
  overallSuccessRate: number;
  avgDurationMs: number;
  healthStatus: string;
  authStatus: string;
  cooldownActive: boolean;
}

export interface AgentRouterOptions {
  runtimeConfiguration?: RuntimeConfigurationStore | undefined;
  providerAccounts?: ProviderAccountService | undefined;
  now?: () => Date;
}

// Empirical baseline profiles for each major CLI model
const BASE_AFFINITIES: Record<string, Record<TaskCategory, number>> = {
  codex: {
    browser: 98,
    code: 95,
    review: 80,
    synthesis: 80,
    research: 75,
    general: 80,
  },
  claude: {
    review: 95,
    synthesis: 95,
    code: 90,
    browser: 90,
    research: 85,
    general: 90,
  },
  antigravity: {
    research: 95,
    general: 85,
    synthesis: 85,
    code: 75,
    review: 75,
    browser: 10,
  },
};

export class AgentRouter {
  readonly #config: RuntimeConfigurationStore | undefined;
  readonly #providerAccounts: ProviderAccountService | undefined;
  readonly #now: () => Date;
  #statsCache: AgentRoutingStats | null = null;

  constructor(options: AgentRouterOptions = {}) {
    this.#config = options.runtimeConfiguration;
    this.#providerAccounts = options.providerAccounts;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Syntactic and semantic analysis of a task instruction.
   */
  classifyTask(instruction: string, contextChars = 0): TaskClassification {
    const text = instruction.toLowerCase();

    // Browser detection
    const browserMatches = (
      text.match(
        /\b(browser|navigation|chromium|chrome|browser-harness|click|url|http|https|dom|form|field|input|screenshot)\b/g,
      ) ?? []
    ).length;
    const requiresBrowser = browserMatches >= 1 || /browser-harness|bu_cdp_url|19222/.test(text);

    // Code detection
    const codeMatches = (
      text.match(
        /\b(code|function|class|method|script|typescript|javascript|python|rust|vitest|test|tests|bug|fix|refactor|git|commit|patch|diff|npm|pnpm|build|compile)\b/g,
      ) ?? []
    ).length;

    // Review / critique detection
    const reviewMatches = (
      text.match(
        /\b(critique|review|verdict|quality|audit|verification|flaw|vulnerability|security|contradiction|contradictions|consistency|evaluate|inspection)\b/g,
      ) ?? []
    ).length;

    // Research / exploration detection
    const researchMatches = (
      text.match(
        /\b(research|search|investigation|explore|analyze|analysis|documentation|source|facts|find|library)\b/g,
      ) ?? []
    ).length;

    // Synthesis detection
    const synthesisMatches = (
      text.match(
        /\b(synthesis|synthesizer|summary|summarize|final report|conclude|conclusion|final answer|assessment)\b/g,
      ) ?? []
    ).length;

    // Relative weights computation
    const weights: Record<TaskCategory, number> = {
      browser: requiresBrowser ? 40 + browserMatches * 10 : browserMatches * 5,
      code: codeMatches * 10,
      review: reviewMatches * 10,
      research: researchMatches * 10,
      synthesis: synthesisMatches * 10,
      general: 10,
    };

    // Determine primary category
    let primaryCategory: TaskCategory = "general";
    let maxWeight = 0;

    for (const cat of TASK_CATEGORIES) {
      if (weights[cat] > maxWeight) {
        maxWeight = weights[cat];
        primaryCategory = cat;
      }
    }

    if (maxWeight === 0) {
      primaryCategory = "general";
      weights.general = 50;
    }

    const estimatedComplexity =
      instruction.length > 500 || (codeMatches > 2 && reviewMatches > 1)
        ? "high"
        : instruction.length > 150
          ? "medium"
          : "low";

    return {
      primaryCategory,
      categoryWeights: weights,
      requiresBrowser,
      estimatedComplexity,
      contextChars: contextChars || instruction.length,
    };
  }

  async loadStats(): Promise<AgentRoutingStats> {
    if (this.#statsCache !== null) return this.#statsCache;
    if (this.#config === undefined) return {};
    const loaded = await this.#config.loadRoutingStats();
    this.#statsCache = loaded ?? {};
    return this.#statsCache;
  }

  async saveStats(stats: AgentRoutingStats): Promise<void> {
    this.#statsCache = stats;
    if (this.#config !== undefined) {
      await this.#config.saveRoutingStats(stats);
    }
  }

  /**
   * Evaluates and ranks all available profiles for a given instruction.
   */
  async rankProfiles(
    profiles: string[],
    instruction: string,
    options?: { contextChars?: number; exclude?: string[] },
  ): Promise<RankedAgent[]> {
    const classification = this.classifyTask(instruction, options?.contextChars);
    const stats = await this.loadStats();
    const accounts = this.#providerAccounts ? await this.#providerAccounts.listAccounts() : [];

    const candidates = profiles.filter((p) => !(options?.exclude ?? []).includes(p));

    const scored: RankedAgent[] = [];

    for (const key of candidates) {
      let isAvailable = true;
      let unavailabilityReason: string | undefined;

      // Determine provider (e.g. "claude-review" -> "claude", "antigravity" -> "antigravity")
      const provider = this.#resolveProvider(key);
      const baseAffinity = BASE_AFFINITIES[provider] ?? BASE_AFFINITIES.claude;
      const agentStats = stats[key] ?? stats[provider];
      const account = accounts.find((a) => a.id === key || a.provider === provider);

      // 1. Intrinsic compatibility + historical learning
      let S_compat = baseAffinity?.[classification.primaryCategory] ?? 80;

      // If the task requires a real browser, codex and claude are the only viable profiles
      if (classification.requiresBrowser && provider !== "codex" && provider !== "claude") {
        S_compat = 0;
        isAvailable = false;
        unavailabilityReason = "Not equipped for local browser";
      }

      // Modulation by learned performance
      const catStats = agentStats?.categories[classification.primaryCategory];
      if (catStats && catStats.runs >= 2) {
        const catSuccessRate = catStats.successes / catStats.runs;
        // Adjustment of +/- 15 points based on success rate in this category
        S_compat += (catSuccessRate - 0.75) * 20;
        // Quality adjustment (pass verdicts)
        if (catStats.runs > 0) {
          const avgQuality = catStats.qualitySum / catStats.runs;
          S_compat += (avgQuality - 0.5) * 10;
        }
      }
      S_compat = Math.max(0, Math.min(100, S_compat));

      // 2. Authentication
      let S_auth = 85;

      if (account) {
        if (account.authStatus === "authenticated") S_auth = 100;
        else if (account.authStatus === "unknown") S_auth = 75;
        else if (account.authStatus === "expired" || account.authStatus === "unauthenticated") {
          S_auth = 0;
          isAvailable = false;
          unavailabilityReason = "Authentication required or expired";
        }
      }

      // 3. Available quota
      let S_quota = 85;
      if (account) {
        if (account.quotas.exhausted) {
          S_quota = 0;
          isAvailable = false;
          unavailabilityReason = "5h or weekly quota exhausted";
        } else if (account.quotas.remaining5hPercent !== null) {
          S_quota = account.quotas.remaining5hPercent;
        }
      }

      // 4. Health & Cooldowns
      let S_health = 100;
      if (account?.cooldown.active) {
        S_health = 0;
        isAvailable = false;
        unavailabilityReason = account.cooldown.reason ?? "Temporarily on cooldown";
      } else if (account) {
        const fails = account.reliability.consecutiveFailures;
        if (fails === 1) S_health = 60;
        else if (fails === 2) S_health = 30;
        else if (fails >= 3) {
          S_health = 0;
          isAvailable = false;
          unavailabilityReason = "Too many recent consecutive failures";
        }
      }

      // 5. Historical quality
      let S_quality = 85;
      if (account) {
        S_quality = Math.round(account.reliability.score * 100);
      } else if (agentStats && agentStats.totalRuns > 0) {
        S_quality = Math.round(agentStats.overallSuccessRate * 100);
      }

      // 6. Performance & Speed
      let S_perf = 80;
      if (catStats && catStats.avgDurationMs > 0) {
        // Average benchmark: 15s (15000ms). Faster gets bonus, >60s gets penalty
        const speedScore = Math.max(
          20,
          Math.min(100, 100 - (catStats.avgDurationMs - 10_000) / 1000),
        );
        S_perf = Math.round(speedScore);
      }

      // 7. Context window length
      let S_context = 90;
      if (classification.contextChars > 60_000) {
        if (provider === "antigravity")
          S_context = 100; // Giant context window
        else if (provider === "claude") S_context = 95;
        else if (provider === "codex") S_context = 75;
      }

      // Compute weighted overall score
      // Weights: compatibility (35%), health (20%), quota (15%), auth (15%), quality (10%), perf (5%)
      const weightedScore =
        S_compat * 0.35 +
        S_health * 0.2 +
        S_quota * 0.15 +
        S_auth * 0.15 +
        S_quality * 0.1 +
        S_perf * 0.05;

      const totalScore = isAvailable ? Math.round(weightedScore) : 0;

      scored.push({
        key,
        totalScore,
        isAvailable,
        unavailabilityReason,
        recommendedCategory: classification.primaryCategory,
        breakdown: {
          compatibility: Math.round(S_compat),
          authentication: Math.round(S_auth),
          quota: Math.round(S_quota),
          health: Math.round(S_health),
          quality: Math.round(S_quality),
          performance: Math.round(S_perf),
          context: Math.round(S_context),
        },
      });
    }

    // Sort: available first, then by descending total score
    scored.sort((a, b) => {
      if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1;
      return b.totalScore - a.totalScore;
    });

    return scored;
  }

  /**
   * Returns the best selected profile for the given instruction.
   */
  async bestProfileFor(
    profiles: string[],
    instruction: string,
    fallbackDefault?: string,
  ): Promise<string> {
    const ranked = await this.rankProfiles(profiles, instruction);
    const available = ranked.find((r) => r.isAvailable && r.totalScore > 0);
    if (available) return available.key;
    return fallbackDefault ?? profiles[0] ?? "";
  }

  /**
   * Generates the ordered chain of optimal fallbacks for a task.
   */
  async fallbackOrderFor(
    primary: string,
    profiles: string[],
    instruction: string,
  ): Promise<string[]> {
    const ranked = await this.rankProfiles(profiles, instruction, { exclude: [primary] });
    return ranked.filter((r) => r.isAvailable && r.totalScore > 0).map((r) => r.key);
  }

  /**
   * Records execution outcome to enrich routing learning.
   */
  async recordOutcome(
    agentKey: string,
    category: TaskCategory,
    outcome: {
      success: boolean;
      durationMs?: number | undefined;
      qualityVerdict?: "pass" | "revise" | undefined;
      errorCategory?: string | undefined;
    },
  ): Promise<void> {
    const stats = await this.loadStats();
    const provider = this.#resolveProvider(agentKey);

    const nowIso = this.#now().toISOString();
    const current = stats[agentKey] ?? {
      categories: {},
      totalRuns: 0,
      overallSuccessRate: 1.0,
      updatedAt: nowIso,
    };

    const catCurrent: CategoryStats = current.categories[category] ?? {
      runs: 0,
      successes: 0,
      failures: 0,
      avgDurationMs: 0,
      qualitySum: 0,
    };

    const nextRuns = catCurrent.runs + 1;
    const nextSuccesses = catCurrent.successes + (outcome.success ? 1 : 0);
    const nextFailures = catCurrent.failures + (outcome.success ? 0 : 1);

    const duration = outcome.durationMs ?? 10_000;
    const nextAvgDuration = Math.round(
      (catCurrent.avgDurationMs * catCurrent.runs + duration) / nextRuns,
    );

    const qualityVal =
      outcome.qualityVerdict === "pass"
        ? 1.0
        : outcome.qualityVerdict === "revise"
          ? 0.3
          : outcome.success
            ? 1.0
            : 0.0;
    const nextQualitySum = catCurrent.qualitySum + qualityVal;

    current.categories[category] = {
      runs: nextRuns,
      successes: nextSuccesses,
      failures: nextFailures,
      avgDurationMs: nextAvgDuration,
      qualitySum: nextQualitySum,
    };

    current.totalRuns += 1;
    let totalSucc = 0;
    let totalAll = 0;
    for (const c of Object.values(current.categories)) {
      if (c) {
        totalSucc += c.successes;
        totalAll += c.runs;
      }
    }
    current.overallSuccessRate = totalAll > 0 ? Number((totalSucc / totalAll).toFixed(2)) : 1.0;
    current.updatedAt = nowIso;

    stats[agentKey] = current;
    // If the key differs from provider, also update parent provider
    if (provider !== agentKey && !stats[provider]) {
      stats[provider] = { ...current };
    }

    await this.saveStats(stats);
  }

  /**
   * Returns the complete matrix of competencies and scores per category.
   */
  async getRoutingMatrix(profiles: string[]): Promise<RoutingMatrixItem[]> {
    const stats = await this.loadStats();
    const accounts = this.#providerAccounts ? await this.#providerAccounts.listAccounts() : [];

    const matrix: RoutingMatrixItem[] = [];

    for (const key of profiles) {
      const provider = this.#resolveProvider(key);
      const baseAffinity = BASE_AFFINITIES[provider] ?? BASE_AFFINITIES.claude;
      const agentStats = stats[key] ?? stats[provider];
      const account = accounts.find((a) => a.id === key || a.provider === provider);

      const categoryScores: Record<TaskCategory, number> = {
        code: baseAffinity?.code ?? 70,
        research: baseAffinity?.research ?? 70,
        review: baseAffinity?.review ?? 70,
        browser: baseAffinity?.browser ?? 70,
        synthesis: baseAffinity?.synthesis ?? 70,
        general: baseAffinity?.general ?? 70,
      };

      // Enrichment with learning
      let totalDuration = 0;
      let durationCount = 0;

      for (const cat of TASK_CATEGORIES) {
        const catStats = agentStats?.categories[cat];
        if (catStats && catStats.runs > 0) {
          const successRate = catStats.successes / catStats.runs;
          categoryScores[cat] = Math.round(
            Math.max(0, Math.min(100, categoryScores[cat] + (successRate - 0.7) * 20)),
          );
          if (catStats.avgDurationMs > 0) {
            totalDuration += catStats.avgDurationMs;
            durationCount++;
          }
        }
      }

      matrix.push({
        key,
        categoryScores,
        totalRuns: agentStats?.totalRuns ?? account?.reliability.totalRuns ?? 0,
        overallSuccessRate: agentStats?.overallSuccessRate ?? account?.reliability.score ?? 1.0,
        avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
        healthStatus: account?.cooldown.active
          ? "cooldown"
          : account?.quotas.exhausted
            ? "quota_exhausted"
            : "available",
        authStatus: account?.authStatus ?? "unknown",
        cooldownActive: account?.cooldown.active ?? false,
      });
    }

    return matrix;
  }

  async resetStats(): Promise<void> {
    await this.saveStats({});
  }

  #resolveProvider(profileKey: string): string {
    const clean = profileKey.toLowerCase();
    if (clean.includes("claude")) return "claude";
    if (clean.includes("antigravity") || clean.includes("gemini") || clean.includes("agy"))
      return "antigravity";
    if (clean.includes("codex") || clean.includes("gpt")) return "codex";
    return clean;
  }
}
