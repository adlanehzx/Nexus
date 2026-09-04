import type { RiskLevel } from "@nexus/tools";
import { PolicyViolationError } from "../errors.js";

/**
 * Politique Git.
 *
 * La séparation lecture / écriture n'est pas décorative : c'est elle qui décide
 * si NEXUS agit seul ou demande d'abord. `git status` n'a aucune conséquence ;
 * `git checkout` peut effacer un travail non commis, `git commit` inscrit une
 * ligne dans une histoire partagée, `git pull` fusionne du code venu d'ailleurs.
 *
 * Le niveau de risque déclaré ici alimente `PermissionService` et
 * `ConfirmationService` du cœur. Le worker ne décide donc pas seul de ce qui
 * mérite une confirmation — il déclare ce qu'il s'apprête à faire, et le système
 * central tranche.
 */

export type GitOperation = "status" | "diff" | "branch" | "pull" | "checkout" | "clone" | "commit";

/** Opérations qui ne modifient ni l'arbre de travail ni l'historique. */
export const GIT_READ_OPERATIONS: readonly GitOperation[] = ["status", "diff", "branch"];

/**
 * Risque par opération.
 *
 * `checkout` est en HIGH et non en MEDIUM : c'est la seule opération de cette
 * liste capable de détruire un travail non enregistré, sans confirmation ni
 * moyen de revenir en arrière.
 */
export const GIT_RISK: Record<GitOperation, RiskLevel> = {
  status: "SAFE",
  diff: "SAFE",
  branch: "SAFE",
  pull: "MEDIUM",
  clone: "MEDIUM",
  commit: "MEDIUM",
  checkout: "HIGH",
};

export function isReadOperation(operation: GitOperation): boolean {
  return GIT_READ_OPERATIONS.includes(operation);
}

export interface GitPolicyOptions {
  /** Autorise les opérations qui écrivent. Défaut : non. */
  allowWrite?: boolean;
  /** Hôtes acceptés pour `clone`. Vide = aucun clone distant. */
  allowedRemoteHosts?: readonly string[];
}

export const DEFAULT_REMOTE_HOSTS = ["github.com", "gitlab.com"] as const;

export class GitPolicy {
  readonly #allowWrite: boolean;
  readonly #allowedHosts: Set<string>;

  constructor(options: GitPolicyOptions = {}) {
    this.#allowWrite = options.allowWrite ?? false;
    const hosts =
      options.allowedRemoteHosts && options.allowedRemoteHosts.length > 0
        ? options.allowedRemoteHosts
        : DEFAULT_REMOTE_HOSTS;
    this.#allowedHosts = new Set(hosts.map((host) => host.toLowerCase()));
  }

  get allowsWrite(): boolean {
    return this.#allowWrite;
  }

  riskFor(operation: GitOperation): RiskLevel {
    return GIT_RISK[operation];
  }

  /** @throws {PolicyViolationError} si l'opération écrit sans y être autorisée. */
  assertAllowed(operation: GitOperation): void {
    if (isReadOperation(operation)) return;
    if (this.#allowWrite) return;

    throw new PolicyViolationError({
      rule: "git.readOnly",
      message: `Opération Git modifiante refusée : ${operation}`,
      userMessage: `Cet appareil est configuré en lecture seule pour Git ; « ${operation} » est refusé.`,
      context: { operation },
    });
  }

  /**
   * Valide l'URL d'un dépôt distant.
   *
   * Deux refus qui comptent : un hôte hors liste, et surtout le schéma
   * `ext::` de Git, qui exécute une commande arbitraire au moment du clone. Il
   * transformerait `git.clone` en exécution de code sans passer par la politique
   * d'exécution.
   */
  assertRemoteAllowed(url: string): void {
    const raw = url.trim();

    if (/^(ext|fd|file)::/i.test(raw) || raw.toLowerCase().startsWith("file://")) {
      throw new PolicyViolationError({
        rule: "git.remoteScheme",
        message: `Schéma de dépôt refusé : ${raw.slice(0, 32)}`,
        userMessage: "Ce type d'adresse de dépôt n'est pas autorisé.",
      });
    }

    let host: string;
    try {
      // Forme SSH abrégée (`git@github.com:org/dépôt.git`), que `URL` ne lit pas.
      const sshMatch = /^[^@]+@([^:]+):/.exec(raw);
      host = sshMatch?.[1] ?? new URL(raw).hostname;
    } catch {
      throw new PolicyViolationError({
        rule: "git.remoteUrl",
        message: "Adresse de dépôt illisible",
        userMessage: "L'adresse du dépôt est invalide.",
      });
    }

    if (!this.#allowedHosts.has(host.toLowerCase())) {
      throw new PolicyViolationError({
        rule: "git.remoteHost",
        message: `Hôte de dépôt non autorisé : ${host}`,
        userMessage: `Les dépôts hébergés sur « ${host} » ne sont pas autorisés.`,
        context: { host, allowed: [...this.#allowedHosts] },
      });
    }
  }
}
