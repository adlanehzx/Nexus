import { z } from "zod";

/**
 * Niveaux de risque d'une action.
 *
 * L'échelle est ordonnée : `SAFE < LOW < MEDIUM < HIGH < CRITICAL`. Cet ordre
 * n'est pas décoratif — c'est lui qui permet à une politique de dire « approuve
 * automatiquement jusqu'à LOW » et à l'évaluation de n'aller que dans un sens.
 *
 * Règle du projet : un risque peut être **élevé** par le contexte ou les
 * arguments, jamais abaissé. Un outil déclaré HIGH ne devient pas SAFE parce que
 * ses arguments semblent anodins.
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

/** Vrai si `level` est au moins aussi risqué que `threshold`. */
export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

/** Le plus élevé des niveaux fournis. Sert à l'escalade, qui ne va que vers le haut. */
export function maxRisk(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (worst, level) => (RANK[level] > RANK[worst] ? level : worst),
    "SAFE",
  );
}
