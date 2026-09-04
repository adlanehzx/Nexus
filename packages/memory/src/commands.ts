/**
 * Commandes explicites de mémoire.
 *
 * « Retiens que… » et « Oublie… » ne passent **pas** par le modèle. C'est une
 * décision, et elle a deux raisons :
 *
 *  1. **Une commande doit être fiable.** Un utilisateur qui dit « oublie mon
 *     adresse » doit voir son adresse disparaître, pas espérer que le modèle
 *     l'ait interprété ainsi. Une reconnaissance déterministe rate parfois une
 *     formulation exotique — l'utilisateur reformule. Un modèle, lui, se trompe
 *     silencieusement, et personne ne s'en aperçoit avant des semaines.
 *
 *  2. **Elle doit être vérifiable.** Ces fonctions se testent ; une intention
 *     déduite par un LLM, non.
 *
 * La reconnaissance est **ancrée au début du message** et exige l'impératif.
 * C'est ce qui distingue « Retiens que je préfère le train » d'une phrase où
 * l'utilisateur *raconte* qu'il se souvient de quelque chose : « je me souviens
 * que le train était en retard » n'est pas un ordre, et le prendre pour tel
 * remplirait la mémoire de bruit.
 */

export type MemoryCommand =
  { kind: "remember"; content: string } | { kind: "forget"; target: string; all: boolean };

/**
 * Formes reconnues pour « retiens ».
 *
 * Le `que`/`this`/`ceci` est facultatif : « Retiens : rendez-vous mardi » est
 * une formulation naturelle qu'on ne peut pas refuser au motif qu'elle omet la
 * conjonction.
 */
const REMEMBER_PATTERNS: RegExp[] = [
  /^\s*(?:retiens|souviens[- ]toi|rappelle[- ]toi|m[ée]morise|note)\b[\s:,]*(?:que|ceci|cela|ça)?[\s:,]*(.+)$/is,
  /^\s*(?:remember|memorize|note)\b[\s:,]*(?:that|this|the\s+following)?[\s:,]*(.+)$/is,
];

const FORGET_PATTERNS: RegExp[] = [
  /^\s*(?:oublie|efface|supprime)\b[\s:,]*(?:que|ceci|cela|ça)?[\s:,]*(.+)$/is,
  /^\s*(?:forget|erase|delete)\b[\s:,]*(?:that|this|about)?[\s:,]*(.+)$/is,
];

/**
 * Formes qui demandent un oubli **total**.
 *
 * Distinguées parce qu'elles n'appellent pas la même confirmation : effacer un
 * souvenir se défait en le redisant, effacer toute la mémoire ne se défait pas.
 */
const FORGET_ALL_PATTERNS: RegExp[] = [
  /^\s*(?:oublie|efface|supprime)\s+(?:tout|toute\s+(?:ta|la)\s+m[ée]moire|mes\s+souvenirs)\b/i,
  /^\s*(?:forget|erase|delete)\s+(?:everything|all(?:\s+(?:my|your))?\s*(?:memor(?:y|ies))?)\b/i,
];

/**
 * Reconnaît une commande de mémoire.
 *
 * Rend `undefined` pour tout le reste — c'est-à-dire pour l'immense majorité des
 * messages. Ne rien reconnaître est le comportement normal, pas un échec.
 */
export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  // Les formes totales passent d'abord : « oublie tout » satisfait aussi le
  // motif général, qui en tirerait un contenu à chercher — « tout ».
  for (const pattern of FORGET_ALL_PATTERNS) {
    if (pattern.test(trimmed)) return { kind: "forget", target: "", all: true };
  }

  for (const pattern of REMEMBER_PATTERNS) {
    const match = pattern.exec(trimmed);
    const content = match?.[1]?.trim();
    if (content !== undefined && content.length > 0) {
      return { kind: "remember", content: stripTrailingPunctuation(content) };
    }
  }

  for (const pattern of FORGET_PATTERNS) {
    const match = pattern.exec(trimmed);
    const target = match?.[1]?.trim();
    if (target !== undefined && target.length > 0) {
      return { kind: "forget", target: stripTrailingPunctuation(target), all: false };
    }
  }

  return undefined;
}

/**
 * Retire la ponctuation finale.
 *
 * « Retiens que je préfère le train. » et « Retiens que je préfère le train »
 * doivent produire le même souvenir, sans quoi les redire crée un doublon.
 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?;,\s]+$/u, "");
}
