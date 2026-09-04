import { AppError, type AppErrorOptions } from "@nexus/shared";

/**
 * Erreurs du plan de capacité.
 *
 * Toutes portent `retryable`, qui pilote la politique de reprise de l'exécuteur.
 * Le principe : on ne réessaie que ce dont l'échec est plausiblement transitoire.
 * Des arguments invalides le resteront à la seconde tentative.
 *
 * (Pas de propriétés de constructeur ici : `erasableSyntaxOnly` les interdit —
 * elles produiraient du code à l'exécution.)
 */

export class ToolNotFoundError extends AppError {
  readonly code = "TOOL_NOT_FOUND";
  readonly httpStatus = 404;
  readonly toolName: string;

  constructor(toolName: string) {
    super({
      message: `Outil inconnu : ${toolName}`,
      userMessage: "Cet outil n'existe pas.",
      context: { toolName },
    });
    this.toolName = toolName;
  }
}

export class ToolInputValidationError extends AppError {
  readonly code = "TOOL_INPUT_INVALID";
  readonly httpStatus = 400;
  readonly toolName: string;
  readonly issues: unknown;

  constructor(toolName: string, issues: unknown) {
    const detail = formatValidationIssues(issues);
    super({
      message: `Arguments invalides pour ${toolName}`,
      // Le message NOMME les champs fautifs : c'est lui que le modèle recevra en
      // observation, et « paramètres invalides » ne lui dirait pas quoi corriger.
      // Seuls les chemins et les contraintes sont repris, jamais les valeurs reçues.
      userMessage:
        detail === undefined
          ? "Les paramètres fournis à l'outil sont invalides."
          : `Paramètres invalides : ${detail}`,
      context: { toolName, issues },
    });
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** Met en forme des problèmes de validation Zod, sans jamais citer les valeurs. */
function formatValidationIssues(issues: unknown): string | undefined {
  if (!Array.isArray(issues) || issues.length === 0) return undefined;

  const parts = issues.slice(0, 5).map((raw) => {
    const issue = raw as { path?: readonly PropertyKey[]; message?: string };
    const path = (issue.path ?? []).map(String).join(".");
    const message = issue.message ?? "invalide";
    return path.length > 0 ? `${path} — ${message}` : message;
  });

  return parts.join(" ; ");
}

/**
 * Sortie non conforme au schéma déclaré. C'est un bug de l'outil, jamais une
 * faute de l'appelant — et surtout pas quelque chose qu'un nouvel essai corrigera.
 */
export class ToolOutputValidationError extends AppError {
  readonly code = "TOOL_OUTPUT_INVALID";
  readonly httpStatus = 500;
  readonly toolName: string;
  readonly issues: unknown;

  constructor(toolName: string, issues: unknown) {
    super({
      message: `Sortie non conforme au schéma pour ${toolName}`,
      userMessage: "L'outil a renvoyé un résultat inattendu.",
      context: { toolName, issues },
    });
    this.toolName = toolName;
    this.issues = issues;
  }
}

export class ToolTimeoutError extends AppError {
  readonly code = "TOOL_TIMEOUT";
  readonly httpStatus = 504;
  override readonly retryable = true;
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super({
      message: `L'outil ${toolName} a dépassé son délai de ${String(timeoutMs)} ms`,
      userMessage: "L'outil a mis trop de temps à répondre.",
      context: { toolName, timeoutMs },
    });
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export class ToolCancelledError extends AppError {
  readonly code = "TOOL_CANCELLED";
  readonly httpStatus = 499;
  readonly toolName: string;

  constructor(toolName: string) {
    super({
      message: `Exécution de ${toolName} annulée`,
      userMessage: "L'opération a été annulée.",
      context: { toolName },
    });
    this.toolName = toolName;
  }
}

export class PermissionDeniedError extends AppError {
  readonly code = "PERMISSION_DENIED";
  readonly httpStatus = 403;
  readonly toolName: string;
  readonly missing: readonly string[];

  constructor(toolName: string, missing: readonly string[]) {
    super({
      message: `Permissions manquantes pour ${toolName} : ${missing.join(", ")}`,
      userMessage: "Cette action n'est pas autorisée.",
      context: { toolName, missing },
    });
    this.toolName = toolName;
    this.missing = missing;
  }
}

/** Échec levé par l'outil lui-même. Réessayable seulement s'il le déclare. */
export class ToolExecutionError extends AppError {
  readonly code = "TOOL_EXECUTION_FAILED";
  readonly httpStatus = 502;
  override readonly retryable: boolean;
  readonly toolName: string;

  constructor(toolName: string, options: AppErrorOptions & { retryable?: boolean }) {
    super(options);
    this.toolName = toolName;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Levée par un outil pour signaler un échec transitoire (réseau, 429, 5xx).
 * C'est le seul moyen pour un outil de demander explicitement une reprise.
 */
export class RetryableToolError extends ToolExecutionError {
  constructor(toolName: string, options: AppErrorOptions) {
    super(toolName, { ...options, retryable: true });
  }
}

/** Le résultat d'exécution attaché à un échec, normalisé pour le modèle. */
export interface NormalizedToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export function normalizeToolError(error: unknown, toolName: string): NormalizedToolError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.userMessage, retryable: error.retryable };
  }
  const wrapped = new ToolExecutionError(toolName, {
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
  return { code: wrapped.code, message: wrapped.userMessage, retryable: false };
}
