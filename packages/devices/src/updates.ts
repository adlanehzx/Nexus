/**
 * Versions des exécutants, et pourquoi NEXUS ne les met pas à jour lui-même.
 *
 * ## La décision
 *
 * Le cœur **constate** la version d'un worker ; il ne la change pas. Il n'y a
 * pas de canal « installe cette version », et ce n'est pas un manque à combler.
 *
 * Un tel canal serait de l'exécution de code à distance, par construction : le
 * cœur dirait à une machine de télécharger puis de lancer quelque chose. Or
 * tout le plan appareil repose sur l'hypothèse inverse — la politique locale
 * existe précisément « pour que si le cœur est compromis, le poste ne devienne
 * pas une machine ouverte ». Une mise à jour poussée rendrait cette phrase
 * fausse, et rendrait inutile tout le reste : refus par défaut, confiance
 * explicite, capacités déclarées.
 *
 * Mettre à jour reste donc un geste **local** : gestionnaire de paquets,
 * installeur, ou `git pull` suivi d'un redémarrage du service. Ce que le cœur
 * apporte, c'est de savoir **qu'il faut le faire** — ce qui est le vrai manque,
 * parce qu'un worker en retard de six mois ne se signale pas tout seul.
 *
 * ## Ce que ce module fait
 *
 * Comparer deux versions, et qualifier l'écart. Rien de plus, et c'est
 * volontairement sans effet de bord : une fonction pure se teste sur ses cas
 * limites, qui sont nombreux dès qu'on compare des numéros de version.
 */

export type WorkerUpdateStatus =
  /** Même version que celle attendue. */
  | "a-jour"
  /** En retard : une version plus récente est attendue. */
  | "en-retard"
  /** En avance — développement local, ou déploiement partiel en cours. */
  | "en-avance"
  /** Version absente ou illisible, ou aucune version attendue n'est configurée. */
  | "inconnu";

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  /** Partie de pré-version, par exemple `rc.1`. Absente le plus souvent. */
  prerelease: string | undefined;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Lit une version, ou rend `undefined`.
 *
 * Ne lève pas : une version illisible est une **observation** — un worker a
 * annoncé n'importe quoi — et non une erreur de programmation. Elle se traduit
 * en statut `inconnu`, ce qui est affichable ; une exception, non.
 */
export function parseVersion(value: string | null | undefined): SemanticVersion | undefined {
  if (value === null || value === undefined) return undefined;
  const match = VERSION.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

/**
 * Compare deux versions : négatif si `left` est plus ancienne.
 *
 * Les pré-versions sont **plus anciennes** que la version finale correspondante
 * — `1.2.0-rc.1` précède `1.2.0` — conformément à l'usage sémantique. Entre
 * deux pré-versions, la comparaison est lexicographique sur la chaîne : c'est
 * approximatif, et suffisant pour la seule question posée ici, « faut-il mettre
 * à jour ? ». Un ordre total exact entre `rc.9` et `rc.10` ne changerait aucune
 * décision.
 */
export function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export interface UpdateAdvice {
  status: WorkerUpdateStatus;
  current: string | null;
  expected: string | null;
  /**
   * Ce qu'il faut faire, en une phrase, ou `null` s'il n'y a rien à faire.
   *
   * Porté par l'avis plutôt que construit par l'interface : « en retard » sans
   * geste associé oblige chaque surface à réinventer la phrase, et à se tromper
   * en laissant croire qu'un bouton pourrait mettre à jour.
   */
  action: string | null;
}

/**
 * Qualifie l'écart entre la version d'un worker et celle attendue.
 *
 * `expected` absent rend `inconnu` sans rien reprocher : une installation qui
 * n'a pas déclaré de version attendue n'est pas en faute, elle n'a simplement
 * pas d'avis à donner. Inventer « à jour » dans ce cas serait affirmer ce qu'on
 * ne sait pas.
 */
export function updateAdvice(
  current: string | null | undefined,
  expected: string | null | undefined,
): UpdateAdvice {
  const currentVersion = parseVersion(current);
  const expectedVersion = parseVersion(expected);
  const shown = { current: current ?? null, expected: expected ?? null };

  if (currentVersion === undefined || expectedVersion === undefined) {
    return {
      ...shown,
      status: "inconnu",
      action:
        expectedVersion === undefined
          ? null
          : "Version de l'exécutant inconnue : vérifiez qu'il démarre et qu'il s'enregistre.",
    };
  }

  const order = compareVersions(currentVersion, expectedVersion);
  if (order === 0) return { ...shown, status: "a-jour", action: null };
  if (order > 0) {
    return {
      ...shown,
      status: "en-avance",
      action: "Cet exécutant est plus récent que la version attendue par le cœur.",
    };
  }
  return {
    ...shown,
    status: "en-retard",
    // Le geste est local, et la phrase le dit. NEXUS ne met pas à jour un
    // poste : il n'a pas de canal pour cela, et c'est délibéré.
    action: `Mettez à jour cet exécutant sur sa machine (version attendue ${expected ?? "?"}), puis redémarrez son service.`,
  };
}
