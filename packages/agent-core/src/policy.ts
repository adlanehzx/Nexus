import type { RiskLevel, RetryPolicy } from "@nexus/tools";

/**
 * Politique d'exécution.
 *
 * Ce sont des **données**, pas des constantes compilées : « surveille ce
 * déploiement » et « quel temps fait-il » n'ont pas le même profil de budget.
 * Une politique voyage avec le run et peut être ajustée par appel.
 */
export interface ExecutionPolicy {
  /** Nombre maximal d'aller-retours avec le modèle. */
  maxIterations: number;
  /** Délai global du run, tout compris sauf l'attente d'une confirmation. */
  globalTimeoutMs: number;
  /** Délai par tentative d'outil, si l'outil n'en déclare pas. */
  defaultToolTimeoutMs: number;
  retry: RetryPolicy;
  /**
   * Après N échecs d'outil consécutifs, on arrête : le modèle tourne en rond et
   * chaque itération coûte de l'argent sans rapprocher du but.
   */
  maxConsecutiveToolFailures: number;
  /**
   * Anti-boucle : nombre de fois qu'un même outil peut être appelé avec des
   * arguments identiques. Au-delà, l'appel est refusé avec une observation
   * explicite plutôt que réexécuté.
   */
  maxIdenticalToolCalls: number;
  /** Nombre maximal d'appels d'outils sur l'ensemble du run. */
  maxToolCalls: number;
  /** Risque maximal exécuté sans confirmation humaine. */
  autoApproveMaxRisk: RiskLevel;
  /** Jetons alloués à une réponse du modèle. */
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
