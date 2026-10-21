/**
 * Lecture et comparaison de versions sémantiques.
 *
 * Ici, et non dans chaque paquet qui en a besoin, parce que la comparaison de
 * versions est un classique des erreurs silencieuses : `"10" < "9"` en
 * comparaison de chaînes, et une pré-version qui passe pour plus récente que la
 * version finale. Deux implémentations, c'est deux occasions de se tromper —
 * et celle qui se trompe décide quand même de mettre à jour.
 */

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
 * Ne lève pas : une version illisible est une **observation** — quelque chose a
 * annoncé n'importe quoi — et non une erreur de programmation. Elle se traduit
 * en « inconnu », ce qui est affichable ; une exception, non.
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
 * deux pré-versions, la comparaison est lexicographique : approximatif, et
 * suffisant pour la seule question posée, « faut-il mettre à jour ? ». Un ordre
 * exact entre `rc.9` et `rc.10` ne changerait aucune décision.
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

/** Compare deux chaînes de version. `undefined` si l'une est illisible. */
export function compareVersionStrings(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return undefined;
  return compareVersions(a, b);
}
