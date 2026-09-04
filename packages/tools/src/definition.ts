import type { z } from "zod";
import type { RiskLevel } from "./risk.js";
import type { Permission } from "./permissions.js";
import type { NormalizedToolError } from "./errors.js";

/**
 * Contexte transmis à un outil pendant son exécution.
 *
 * Il ne contient volontairement aucun secret : les identifiants tiers sont
 * résolus par l'exécuteur, après la décision de permission, et ne transitent
 * jamais par le modèle ni par les journaux.
 */
export interface ToolContext {
  runId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
  /** Annulation coopérative : combine l'annulation du run et le délai de l'outil. */
  signal: AbortSignal;
  /** Dérivée de (runId, index d'étape, outil, hash des arguments). */
  idempotencyKey: string;
  /** Numéro de tentative, à partir de 1. Un outil peut l'utiliser pour tracer. */
  attempt: number;
  /**
   * Signale une progression pendant l'exécution.
   *
   * Un outil long — navigation web, commande shell, upload — doit pouvoir dire
   * où il en est. Sans ce canal, l'utilisateur ne voit qu'un sablier, ce qui est
   * la principale raison pour laquelle un agent paraît bloqué alors qu'il
   * travaille. Toujours défini : par défaut, une fonction sans effet.
   */
  onProgress: (progress: ToolProgress) => void;
}

export interface ToolProgress {
  /** Avancement de 0 à 100, quand il est connu. */
  pct?: number;
  /** Libellé court destiné à l'interface : « ouverture de example.com ». */
  label?: string;
  /** Fragment de sortie en continu (stdout, texte extrait). */
  chunk?: string;
}

/**
 * Description d'un outil.
 *
 * `execute` renvoie la sortie ou **lève**. C'est l'exécuteur qui transforme cela
 * en `ToolResult` : un auteur d'outil écrit du code normal, il n'a pas à
 * construire un objet résultat à la main.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Identifiant stable et unique, en `domaine.action`. */
  name: string;
  /** Pour le modèle : quand utiliser cet outil ET quand ne pas l'utiliser. */
  description: string;
  version?: string;

  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;

  /**
   * Schéma JSON d'entrée déjà connu.
   *
   * Renseigné par les outils **découverts dynamiquement** — un serveur MCP
   * déclare ses entrées en JSON Schema, pas en Zod. On décrit alors au modèle le
   * schéma d'origine du serveur plutôt qu'une traduction approximative. Absent
   * pour les outils natifs, dont le schéma est dérivé du Zod.
   */
  inputJsonSchema?: Record<string, unknown>;

  riskLevel: RiskLevel;
  requiredPermissions: readonly Permission[];

  /**
   * Confirmation humaine requise ?
   *
   * La forme fonction existe parce que **le risque dépend des arguments** :
   * écrire dans `~/scratch/note.md` et dans `/etc/hosts` ne sont pas le même
   * acte. Elle est évaluée après validation des arguments, donc sur des données
   * déjà typées.
   */
  requiresConfirmation: boolean | ((input: TInput, context: ToolContext) => boolean);

  /** Délai maximal d'une tentative. L'exécuteur applique le sien à défaut. */
  timeoutMs?: number;

  /** Un outil non idempotent n'est jamais rejoué automatiquement. */
  idempotent?: boolean;

  /** Surcharge la politique de reprise globale pour cet outil. */
  retry?: { attempts: number };

  /** Résumé court destiné à l'humain, affiché dans la carte de confirmation. */
  summarize?: (input: TInput) => string;

  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

/** Un outil dont on ne connaît pas les paramètres à la compilation. */
export type AnyToolDefinition = ToolDefinition<never, unknown>;

export interface ToolMetrics {
  durationMs: number;
  attempts: number;
}

/**
 * Résultat produit par l'exécuteur.
 *
 * `summaryForModel` est distinct de `output` : le modèle reçoit une projection
 * bornée, pendant que la sortie complète reste disponible pour l'application.
 * C'est ce qui empêche une lecture de fichier de 3 Mo de saturer le contexte.
 */
export type ToolResult<TOutput = unknown> =
  | {
      ok: true;
      toolName: string;
      output: TOutput;
      summaryForModel: string;
      metrics: ToolMetrics;
    }
  | {
      ok: false;
      toolName: string;
      error: NormalizedToolError;
      summaryForModel: string;
      metrics: ToolMetrics;
    };

/** Évalue `requiresConfirmation`, qui peut être un booléen ou un prédicat. */
export function toolRequiresConfirmation<I, O>(
  tool: ToolDefinition<I, O>,
  input: I,
  context: ToolContext,
): boolean {
  return typeof tool.requiresConfirmation === "function"
    ? tool.requiresConfirmation(input, context)
    : tool.requiresConfirmation;
}
