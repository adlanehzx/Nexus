import type { ToolContext, ToolDefinition } from "./definition.js";
import { toolRequiresConfirmation } from "./definition.js";
import { missingPermissions } from "./permissions.js";
import { maxRisk, riskAtLeast, riskRank, type RiskLevel } from "./risk.js";

/**
 * Verdict d'autorisation.
 *
 * `deny` porte toujours une raison lisible : elle est réinjectée au modèle comme
 * observation, ce qui lui permet de proposer une alternative ou d'expliquer à
 * l'utilisateur ce qu'il faudrait autoriser. Un refus n'est pas un plantage.
 */
export type PermissionDecision =
  | { effect: "allow" }
  | { effect: "confirm"; riskLevel: RiskLevel; reason: string }
  | { effect: "deny"; reason: string; missing: readonly string[] };

/** Source des permissions accordées à un utilisateur. */
export interface GrantProvider {
  listGranted(userId: string): Promise<readonly string[]>;
}

/** Implémentation en mémoire — développement, tests, et amorçage. */
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
  /**
   * Risque maximal exécuté sans confirmation. Défaut `LOW` : lecture et actions
   * anodines passent, tout le reste demande un accord explicite.
   */
  autoApproveMaxRisk?: RiskLevel;
  /**
   * Coupe-circuit global : refuse toute action au-dessus de SAFE sans
   * redéploiement. Sert d'interrupteur d'urgence.
   */
  /**
   * Coupe-circuit global : refuse tout outil de risque `LOW` ou plus.
   *
   * Accepte une **fonction** autant qu'un booléen, et c'est ce qui le rend
   * actionnable : un booléen figé à la construction ne peut être changé qu'en
   * reconstruisant le service, donc en perdant tout ce qui en dépend. Une
   * fermeture est consultée à chaque autorisation, donc une pause prend effet
   * sur l'appel suivant.
   */
  readOnly?: boolean | (() => boolean);
}

/**
 * Service de permissions.
 *
 * Refus par défaut : l'absence d'autorisation vaut interdiction. Le service ne
 * connaît ni le LLM ni la base — il reçoit un sujet, un outil et des arguments
 * déjà validés, et rend un verdict.
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
   * Ordre d'évaluation — premier verdict gagnant. L'ordre est le contrat :
   * le coupe-circuit précède tout, et le refus par défaut ferme la marche.
   */
  async check<I, O>(
    tool: ToolDefinition<I, O>,
    input: I,
    context: ToolContext,
  ): Promise<PermissionDecision> {
    // 1. Coupe-circuit global.
    if (this.#readOnly() && riskAtLeast(tool.riskLevel, "LOW")) {
      return {
        effect: "deny",
        reason: "NEXUS est en pause : seules les actions sans effet de bord restent autorisées.",
        missing: [],
      };
    }

    // 2. Permissions manquantes.
    const granted = await this.#grants.listGranted(context.userId);
    const missing = missingPermissions(granted, tool.requiredPermissions);
    if (missing.length > 0) {
      return {
        effect: "deny",
        reason: `Permissions manquantes : ${missing.join(", ")}.`,
        missing,
      };
    }

    // 3. CRITICAL demande toujours une confirmation, quoi que déclare l'outil.
    //    Un outil ne peut pas s'auto-dispenser d'un accord sur une action
    //    irréversible.
    if (tool.riskLevel === "CRITICAL") {
      return {
        effect: "confirm",
        riskLevel: "CRITICAL",
        reason: "Action irréversible : confirmation explicite requise.",
      };
    }

    // 4. L'outil réclame une confirmation, éventuellement selon ses arguments.
    if (toolRequiresConfirmation(tool, input, context)) {
      return {
        effect: "confirm",
        riskLevel: maxRisk(tool.riskLevel, "MEDIUM"),
        reason: "Cette action a un effet de bord réel.",
      };
    }

    // 5. Au-dessus du seuil d'auto-approbation.
    if (riskRank(tool.riskLevel) > riskRank(this.#autoApproveMaxRisk)) {
      return {
        effect: "confirm",
        riskLevel: tool.riskLevel,
        reason: `Risque ${tool.riskLevel} supérieur au seuil d'auto-approbation (${this.#autoApproveMaxRisk}).`,
      };
    }

    return { effect: "allow" };
  }
}
