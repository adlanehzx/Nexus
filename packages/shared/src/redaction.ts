/**
 * Rédaction des secrets.
 *
 * Appliquée avant qu'un objet n'entre dans la trace d'un run, dans un événement,
 * ou dans un journal. La liste est volontairement large : rater une rédaction
 * coûte infiniment plus cher qu'en faire une de trop.
 *
 * Deux niveaux, parce qu'un seul ne suffit pas :
 *   - par NOM de clé (`password`, `apiKey`, `authorization`…) ;
 *   - par FORME de valeur (`sk-…`, `ghp_…`, un JWT), car un secret finit
 *     toujours par se retrouver dans un champ innocemment nommé `value`.
 */

const SECRET_KEY_PATTERN =
  /^(pass(word)?|pwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|session|private[_-]?key|master[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // clés d'API de style OpenAI/Anthropic
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // jetons GitHub
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /^Bearer\s+\S{16,}$/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const REDACTED = "[REDACTED]";

function looksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Copie profonde d'une valeur, secrets masqués.
 *
 * `maxDepth` borne la récursion : une structure cyclique ou absurdement profonde
 * ne doit pas faire tomber la journalisation — qui est précisément ce dont on a
 * besoin quand quelque chose va mal.
 */
export function redact(value: unknown, maxDepth = 8): unknown {
  return redactAt(value, maxDepth, new WeakSet());
}

function redactAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // Une chaîne conservée passe quand même par la rédaction en ligne : un secret
  // ne se présente pas toujours comme la valeur entière d'un champ bien nommé.
  // Il arrive au milieu d'un contenu de fichier, d'une ligne de journal, d'une
  // URL — et un `content` parfaitement anodin peut le transporter.
  if (typeof value === "string") return looksSecret(value) ? REDACTED : redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return "[profondeur maximale atteinte]";

  if (seen.has(value)) return "[référence circulaire]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactAt(item, depth - 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactAt(item, depth - 1, seen);
  }
  return out;
}

/** Tronque un texte destiné à une trace ou à un aperçu. */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}… [tronqué, ${String(text.length)} caractères]`;
}

/**
 * Motifs cherchés **à l'intérieur** d'un texte libre.
 *
 * `redact` travaille sur des structures : il voit une clé `password` et masque
 * sa valeur. Rien de tel n'existe dans la sortie d'un processus, où un secret
 * arrive noyé au milieu d'une ligne de journal. Ces expressions cherchent donc
 * la forme du secret elle-même, ancrée sur un mot-clé quand il y en a un.
 *
 * **L'ordre compte.** Les motifs qui reconnaissent un secret à sa seule forme
 * passent en premier ; le motif générique `clé=valeur` ferme la marche. Dans
 * l'ordre inverse, `Authorization: Bearer <jeton>` verrait le générique masquer
 * le mot « Bearer » et laisser le jeton en clair juste derrière.
 */
const INLINE_SECRET_PATTERNS: { pattern: RegExp; replace: (match: string) => string }[] = [
  // Jetons reconnaissables à leur seule forme, où qu'ils apparaissent.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REDACTED },
  {
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    replace: () => REDACTED,
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replace: () => `Bearer ${REDACTED}` },
  // Adresse contenant des identifiants : https://user:motdepasse@hote/
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi,
    replace: (match) => match.replace(/:([^\s@]+)@/, `:${REDACTED}@`),
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => REDACTED,
  },
  // clé=valeur / clé: valeur, où la clé trahit un secret.
  //
  // Le nom peut être préfixé — `DATABASE_PASSWORD`, `MY_API_KEY`. Une limite de
  // mot (`\b`) échouerait devant le souligné et laisserait passer exactement les
  // noms de variables qu'on trouve dans un fichier `.env`.
  {
    pattern:
      /[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(\s*[:=]\s*)("?)([^\s"',;]{4,})\2/gi,
    replace: (match) => match.replace(/([:=]\s*"?)([^\s"',;]{4,})/, `$1${REDACTED}`),
  },
];

/**
 * Masque les secrets d'un texte libre.
 *
 * Pensé pour ce qu'écrit un processus enfant : un script qui affiche sa clé
 * d'API, un `git clone` qui recopie une URL contenant un jeton, une trace qui
 * recrache un en-tête `Authorization`. Rien de tout cela n'est maîtrisable en
 * amont — la seule barrière possible est à la sortie.
 *
 * Volontairement généreux : masquer un identifiant anodin coûte une lecture de
 * journal moins précise ; en laisser passer un vrai coûte beaucoup plus.
 */
export function redactText(text: string): string {
  let output = text;
  for (const { pattern, replace } of INLINE_SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => replace(match));
  }
  return output;
}
