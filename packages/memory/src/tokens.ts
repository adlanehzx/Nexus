/** Port d'un tokeniseur exact fourni par l'adaptateur de modèle. */
export interface TokenCounter {
  count(text: string, model?: string): number;
}

/**
 * Repli local conservateur lorsqu'un fournisseur n'expose pas son tokeniseur.
 * Il compte les mots, la ponctuation et les caractères CJK séparément puis
 * applique la marge propre à la famille du modèle. Ce n'est jamais présenté
 * comme la consommation facturée : les usages réels restent ceux du provider.
 */
export class ConservativeTokenCounter implements TokenCounter {
  count(text: string, model?: string): number {
    if (text.length === 0) return 0;
    const pieces =
      text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[^\s]/gu) ??
      [];
    let estimate = 0;
    for (const piece of pieces) {
      if (/^[\p{L}\p{N}_]+$/u.test(piece)) estimate += Math.max(1, Math.ceil(piece.length / 4));
      else estimate += 1;
    }
    return Math.ceil(estimate * modelMargin(model));
  }
}

export interface ModelContextProfile {
  contextWindow: number;
  reservedOutput: number;
  safetyMargin: number;
}

export interface ContextWindowPlan extends ModelContextProfile {
  model: string;
  used: number;
  available: number;
  overflow: number;
}

/** Calcule le budget d'entrée sans coupler la mémoire à un SDK fournisseur. */
export class ContextWindowPlanner {
  readonly #profiles: Readonly<Record<string, ModelContextProfile>>;
  readonly #fallback: ModelContextProfile;

  constructor(
    options: {
      profiles?: Readonly<Record<string, ModelContextProfile>>;
      fallback?: ModelContextProfile;
    } = {},
  ) {
    this.#profiles = options.profiles ?? {};
    this.#fallback = options.fallback ?? {
      contextWindow: 32_000,
      reservedOutput: 4_000,
      safetyMargin: 2_000,
    };
  }

  plan(model: string, used: number): ContextWindowPlan {
    const profile = this.#profiles[model] ?? inferredProfile(model) ?? this.#fallback;
    const capacity = Math.max(
      0,
      profile.contextWindow - profile.reservedOutput - profile.safetyMargin,
    );
    return {
      model,
      ...profile,
      used,
      available: Math.max(0, capacity - used),
      overflow: Math.max(0, used - capacity),
    };
  }
}

function modelMargin(model?: string): number {
  const value = model?.toLowerCase() ?? "";
  if (value.includes("claude")) return 1.12;
  if (value.includes("gemini")) return 1.1;
  return 1.15;
}

function inferredProfile(model: string): ModelContextProfile | undefined {
  const value = model.toLowerCase();
  if (value.includes("claude"))
    return { contextWindow: 200_000, reservedOutput: 8_192, safetyMargin: 4_096 };
  if (value.includes("gemini"))
    return { contextWindow: 1_000_000, reservedOutput: 8_192, safetyMargin: 8_192 };
  if (value.includes("gpt") || value.includes("codex")) {
    return { contextWindow: 128_000, reservedOutput: 8_192, safetyMargin: 4_096 };
  }
  return undefined;
}
