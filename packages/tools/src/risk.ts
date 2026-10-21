import { z } from "zod";

/**
 * Action risk levels.
 * Ordered scale: SAFE < LOW < MEDIUM < HIGH < CRITICAL.
 */
export const RISK_LEVELS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RANK: Record<RiskLevel, number> = {
  SAFE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function riskRank(level: RiskLevel): number {
  return RANK[level];
}

/** Returns true if level is at least as high as threshold. */
export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

/** Returns the highest risk level among provided arguments. */
export function maxRisk(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (worst, level) => (RANK[level] > RANK[worst] ? level : worst),
    "SAFE",
  );
}
