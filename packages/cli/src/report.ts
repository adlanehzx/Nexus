/**
 * Cadre de diagnostic.
 *
 * Un diagnostic n'a de valeur que s'il est **cru**. Deux décisions en
 * découlent, et elles gouvernent tout ce fichier.
 *
 * D'abord, une vérification ne rend jamais un booléen : elle rend un état, un
 * constat et, quand c'est possible, le geste qui corrige. « PostgreSQL : échec »
 * oblige à chercher ; « PostgreSQL injoignable sur 127.0.0.1:15432 — lancer
 * `pnpm docker:up` » ferme la question.
 *
 * Ensuite, `warn` existe et n'est pas un `fail` déguisé. Une installation
 * personnelle sans authentification de service fonctionne ; elle est seulement
 * moins protégée qu'elle pourrait l'être. Confondre les deux conduit à l'un des
 * deux désastres habituels : un diagnostic toujours rouge, qu'on finit par
 * ignorer, ou un diagnostic toujours vert, qui ne dit rien.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  /** Ce qui est vérifié, du point de vue de la personne qui lit. */
  name: string;
  status: CheckStatus;
  /** Constat factuel : ce qu'on a trouvé, pas ce qu'on en déduit. */
  detail: string;
  /** Le geste qui corrige, quand il en existe un. */
  fix?: string;
}

export interface CheckGroup {
  title: string;
  results: CheckResult[];
}

const MARKS: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  skip: "–",
};

/**
 * Compte par état.
 *
 * Séparé du rendu pour que la politique de sortie se teste sans lire du texte.
 */
export function tally(groups: CheckGroup[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const group of groups) {
    for (const result of group.results) counts[result.status] += 1;
  }
  return counts;
}

/**
 * Code de sortie du diagnostic.
 *
 * Seul un `fail` échoue. Un `warn` est une information, et faire échouer sur
 * un avertissement reviendrait à n'avoir aucun moyen de dire « ceci mérite ton
 * attention mais ne casse rien » — la distinction disparaîtrait à l'usage.
 */
export function exitCodeFor(groups: CheckGroup[]): number {
  return tally(groups).fail > 0 ? 1 : 0;
}

/** Rend le rapport en texte. Pure : c'est ce qui la rend testable. */
export function renderReport(groups: CheckGroup[]): string {
  const lines: string[] = [];

  for (const group of groups) {
    if (group.results.length === 0) continue;
    lines.push("", group.title);
    const width = Math.max(...group.results.map((result) => result.name.length));
    for (const result of group.results) {
      lines.push(`  ${MARKS[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
      // Le geste correctif est sur sa propre ligne, indenté : on le copie sans
      // avoir à le découper d'une phrase.
      if (result.fix !== undefined) lines.push(`${" ".repeat(width + 7)}→ ${result.fix}`);
    }
  }

  const counts = tally(groups);
  lines.push(
    "",
    `${counts.ok} ok · ${counts.warn} à surveiller · ${counts.fail} en échec · ${counts.skip} non applicable`,
  );
  return lines.join("\n");
}

export const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });

export const warn = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  status: "warn",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

export const fail = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  status: "fail",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

export const skip = (name: string, detail: string): CheckResult => ({
  name,
  status: "skip",
  detail,
});
