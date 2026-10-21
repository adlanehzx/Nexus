import { compareVersionStrings, parseVersion } from "@nexus/shared";

/**
 * Mise à jour automatique : décider, jamais appliquer.
 *
 * ## La séparation
 *
 * Ce module lit un flux de versions et dit s'il y a quelque chose à installer.
 * Il n'installe rien, ne télécharge rien, n'exécute rien. L'application est le
 * travail de l'hôte — Tauri pour le bureau, le magasin pour le mobile — et
 * c'est lui qui possède la clé publique qui vérifie la signature du paquet.
 *
 * Pourquoi cette séparation : un module qui déciderait **et** appliquerait
 * serait un installeur, c'est-à-dire la pièce la plus sensible de la chaîne —
 * celle qui doit être la plus petite et la plus auditée. Celui-ci est une
 * fonction de comparaison avec des règles, et il se teste entièrement.
 *
 * ## Les refus, qui sont le contenu réel
 *
 * Une mise à jour automatique est un canal d'exécution de code. Les règles
 * ci-dessous ne sont donc pas des garde-fous ajoutés après coup : elles sont la
 * raison d'être du module.
 *
 *  - **Sans signature, pas de mise à jour.** Un flux sans signature n'est pas
 *    un flux incomplet, c'est un flux non fiable : qui le sert peut y mettre
 *    n'importe quel binaire.
 *  - **Pas de retour en arrière.** Proposer une version plus ancienne permet de
 *    réinstaller une faille corrigée.
 *  - **Pas de changement de canal en silence.** Une installation stable ne doit
 *    pas se retrouver en bêta parce que le flux en a proposé une.
 *  - **Pas de saut de version majeure sans accord.** Une majeure peut casser
 *    une configuration ; l'installer pendant la nuit serait une mauvaise
 *    surprise au réveil.
 */

export type UpdateChannel = "stable" | "beta";

export interface ReleaseEntry {
  version: string;
  channel: UpdateChannel;
  /** Signature du paquet. Son absence rend la version inutilisable. */
  signature: string | null;
  url: string;
  notes?: string;
  /** Publication, en millisecondes. */
  publishedAt: number;
}

export type UpdateDecision =
  | { kind: "aucune"; reason: string }
  | { kind: "disponible"; release: ReleaseEntry }
  /** Disponible, mais exige un accord explicite — majeure. */
  | { kind: "accord-requis"; release: ReleaseEntry; reason: string }
  | { kind: "refusée"; reason: string };

export interface UpdatePolicyOptions {
  currentVersion: string;
  channel?: UpdateChannel;
  /**
   * Autoriser une version majeure sans demander.
   *
   * Faux par défaut, et c'est le bon sens : une majeure peut demander une
   * migration, et l'appliquer sans prévenir transforme une mise à jour en
   * panne au réveil.
   */
  allowMajor?: boolean;
}

export class UpdatePolicy {
  readonly #current: string;
  readonly #channel: UpdateChannel;
  readonly #allowMajor: boolean;

  constructor(options: UpdatePolicyOptions) {
    this.#current = options.currentVersion;
    this.#channel = options.channel ?? "stable";
    this.#allowMajor = options.allowMajor ?? false;
  }

  /**
   * Choisit, parmi un flux, la mise à jour applicable.
   *
   * Le flux est une **donnée non fiable** : il vient du réseau. Chaque entrée
   * est donc filtrée sur ses propres mérites, et une entrée malformée est
   * ignorée plutôt que de faire échouer la décision — sans quoi un flux abîmé
   * empêcherait toute mise à jour, y compris celle qui corrige le problème.
   */
  decide(feed: readonly ReleaseEntry[]): UpdateDecision {
    const current = parseVersion(this.#current);
    if (current === undefined) {
      return { kind: "refusée", reason: "version installée illisible" };
    }

    const candidates = feed
      .filter((entry) => parseVersion(entry.version) !== undefined)
      // Le canal d'abord : une installation stable ne doit pas se retrouver en
      // bêta parce que le flux en a proposé une.
      .filter((entry) => entry.channel === this.#channel)
      .filter((entry) => {
        const order = compareVersionStrings(entry.version, this.#current);
        return order !== undefined && order > 0;
      })
      .sort((left, right) => compareVersionStrings(right.version, left.version) ?? 0);

    const best = candidates[0];
    if (best === undefined) return { kind: "aucune", reason: "déjà à jour" };

    if (best.signature === null || best.signature.length === 0) {
      // Un flux sans signature n'est pas incomplet : il est non fiable.
      return { kind: "refusée", reason: "version non signée" };
    }

    const bestVersion = parseVersion(best.version);
    if (bestVersion !== undefined && bestVersion.major > current.major && !this.#allowMajor) {
      return {
        kind: "accord-requis",
        release: best,
        reason: `version majeure ${best.version} : elle peut demander une migration`,
      };
    }

    return { kind: "disponible", release: best };
  }
}
