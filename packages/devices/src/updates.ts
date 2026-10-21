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

// La lecture et la comparaison de versions vivent dans `@nexus/shared` : deux
// implémentations, c'est deux occasions de se tromper — et celle qui se trompe
// décide quand même de mettre à jour.
export { compareVersions, parseVersion, type SemanticVersion } from "@nexus/shared";

// Réexporté ci-dessus pour les appelants, importé ici pour l'usage local : un
// `export … from` ne met rien dans la portée du module.
import { compareVersions, parseVersion } from "@nexus/shared";

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
