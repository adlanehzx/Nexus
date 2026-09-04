import { PolicyViolationError } from "@nexus/worker-core";

/**
 * Politique d'applications.
 *
 * Deux règles, et la seconde compte plus que la première :
 *
 *  1. un nom de paquet doit être un nom de paquet — pas une URI, pas un chemin,
 *    pas un composant `paquet/classe` ;
 *  2. **une liste de refus est appliquée avant toute liste d'autorisation.**
 *    Ouvrir l'application bancaire ou les réglages du système n'a aucun rapport
 *    avec ce qu'on attend d'un assistant, et une capacité `android.app.open`
 *    accordée pour lancer un lecteur de musique ne doit pas ouvrir le gestionnaire
 *    de mots de passe.
 */

/**
 * Forme d'un nom de paquet Android.
 *
 * Au moins deux segments séparés par un point, chacun commençant par une lettre.
 * C'est la règle du système, et la respecter ferme d'un coup toutes les
 * tentatives d'y glisser autre chose : `content://`, `../`, `pkg/.MainActivity`.
 */
const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/**
 * Paquets refusés quoi qu'il arrive.
 *
 * Ce ne sont pas des suggestions. Même si l'utilisateur autorise largement
 * `android.app.open`, ces applications restent fermées : elles donnent accès
 * aux réglages du système, aux moyens de paiement, ou aux secrets stockés.
 *
 * La comparaison porte sur le paquet **et sur ses préfixes** : `com.android.settings`
 * couvre `com.android.settings.suggestion`.
 */
export const ALWAYS_DENIED_PACKAGES = [
  "com.android.settings",
  "com.miui.securitycenter",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.android.certinstaller",
  "com.google.android.apps.walletnfcrel",
  "com.android.vending.billing",
] as const;

/** Fragments qui trahissent une application sensible, où qu'ils apparaissent. */
const DENIED_FRAGMENTS = ["keystore", "keychain", "authenticator", "password", "wallet", "banking"];

export interface AppPolicyOptions {
  /**
   * Paquets autorisés. Vide = tous ceux qui ne sont pas refusés.
   *
   * Une liste explicite est le réglage recommandé pour un téléphone personnel :
   * elle transforme « tout sauf ce que j'ai interdit » en « seulement ce que
   * j'ai voulu ».
   */
  allowedPackages?: readonly string[];
  deniedPackages?: readonly string[];
}

export class AppPolicy {
  readonly #allowed: Set<string> | undefined;
  readonly #denied: string[];

  constructor(options: AppPolicyOptions = {}) {
    this.#allowed =
      options.allowedPackages === undefined || options.allowedPackages.length === 0
        ? undefined
        : new Set(options.allowedPackages.map((name) => name.toLowerCase()));
    this.#denied = [...ALWAYS_DENIED_PACKAGES, ...(options.deniedPackages ?? [])].map((name) =>
      name.toLowerCase(),
    );
  }

  get hasAllowList(): boolean {
    return this.#allowed !== undefined;
  }

  /**
   * Valide un nom de paquet et renvoie sa forme canonique.
   *
   * @throws {PolicyViolationError} sur une forme invalide ou un paquet refusé.
   */
  assertAllowed(packageName: string): string {
    const name = packageName.trim();

    if (!PACKAGE_NAME.test(name)) {
      throw new PolicyViolationError({
        rule: "app.packageName",
        message: `Nom de paquet invalide : ${name.slice(0, 64)}`,
        userMessage: "Ce nom d'application n'est pas valide.",
        context: { packageName: name.slice(0, 128) },
      });
    }

    const lowered = name.toLowerCase();

    // Le refus passe avant l'autorisation : une liste d'autorisation mal
    // renseignée ne doit pas rouvrir les réglages du système.
    for (const denied of this.#denied) {
      if (lowered === denied || lowered.startsWith(`${denied}.`)) {
        throw new PolicyViolationError({
          rule: "app.denied",
          message: `Paquet interdit : ${name}`,
          userMessage: `L'application « ${name} » ne peut pas être ouverte par NEXUS.`,
          context: { packageName: name },
        });
      }
    }

    for (const fragment of DENIED_FRAGMENTS) {
      if (lowered.includes(fragment)) {
        throw new PolicyViolationError({
          rule: "app.sensitive",
          message: `Paquet sensible refusé : ${name}`,
          userMessage: `L'application « ${name} » ne peut pas être ouverte par NEXUS.`,
          context: { packageName: name, fragment },
        });
      }
    }

    if (this.#allowed !== undefined && !this.#allowed.has(lowered)) {
      throw new PolicyViolationError({
        rule: "app.notAllowed",
        message: `Paquet hors liste autorisée : ${name}`,
        userMessage: `L'application « ${name} » n'est pas dans la liste autorisée sur cet appareil.`,
        context: { packageName: name },
      });
    }

    return name;
  }

  /** Variante non levante, pour filtrer une liste. */
  allows(packageName: string): boolean {
    try {
      this.assertAllowed(packageName);
      return true;
    } catch {
      return false;
    }
  }
}
