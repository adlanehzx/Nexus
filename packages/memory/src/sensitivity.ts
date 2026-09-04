import { redactText } from "@nexus/shared";

/**
 * Classification de ce qu'on s'apprête à retenir.
 *
 * La règle du système est : **rien de sensible n'est mémorisé en silence.** Elle
 * se décline en trois verdicts, et la frontière entre eux est une décision, pas
 * une nuance.
 *
 *  - `FORBIDDEN` — **jamais**, quel que soit le demandeur. Mots de passe, clés
 *    d'API, jetons, phrases de récupération, numéros de carte. NEXUS n'est pas
 *    un gestionnaire de mots de passe : il n'offre ni chiffrement au repos
 *    dédié, ni rotation, ni révocation. Accepter ces contenus créerait un coffre
 *    que rien dans l'architecture ne protège comme tel. Un utilisateur qui
 *    insiste doit être renvoyé vers un vrai coffre — c'est plus utile qu'un
 *    stockage qui a l'air sûr.
 *
 *  - `PERSONAL` — **avec accord explicite**. Santé, finances, identifiants
 *    administratifs, adresse précise. Ce sont des informations légitimes à
 *    mémoriser, et un assistant qui les refuse devient inutilisable. Mais
 *    l'utilisateur doit savoir qu'il les confie : l'appelant doit passer
 *    `acknowledgedSensitive: true`, et l'interface ne le fait qu'après avoir
 *    posé la question.
 *
 *  - `ORDINARY` — le reste.
 *
 * La détection est **déterministe**, jamais confiée à un modèle. Un classifieur
 * probabiliste qui se trompe une fois sur cent laisse passer un mot de passe une
 * fois sur cent ; ici, ce qui ressemble à un secret est refusé, point.
 *
 * Elle est aussi **volontairement large**. Refuser à tort coûte à l'utilisateur
 * une reformulation ; accepter à tort coûte un secret dans une base.
 */

export type SensitivityVerdict = "ORDINARY" | "PERSONAL" | "FORBIDDEN";

export interface Classification {
  verdict: SensitivityVerdict;
  /** Noms de catégories reconnues. **Jamais un extrait du contenu.** */
  categories: string[];
  /** Phrase affichable, destinée à l'utilisateur. */
  explanation: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Motifs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce qui est refusé sans discussion.
 *
 * Deux familles : les **formes** reconnaissables (un numéro de carte, une phrase
 * de récupération) et les **déclarations** (« mon mot de passe est … »). La
 * seconde compte autant que la première : c'est ainsi qu'un secret arrive
 * réellement, dicté en langage naturel plutôt qu'en variable d'environnement.
 */
/**
 * Ce qui, après un mot comme « mot de passe », annonce la valeur elle-même.
 *
 * Les verbes portent une limite de mot, la ponctuation non : `\b:` exigerait un
 * caractère de mot juste avant les deux-points, ce qui exclut « le mot de passe
 * du wifi : … » — soit la forme la plus naturelle qui soit.
 */
const ANNONCE = "(?:\\b(?:est|sont|c'est|vaut)\\b|[:=])";

const FORBIDDEN: { category: string; pattern: RegExp }[] = [
  {
    category: "mot-de-passe",
    // `ANNONCE` sépare les verbes de la ponctuation : `\b` autour de « : »
    // exigerait un caractère de mot juste avant, et raterait « le mot de passe
    // du wifi : … » — exactement la forme la plus courante.
    pattern: new RegExp(
      `\\b(mot\\s+de\\s+passe|motdepasse|mdp|password|passphrase|code\\s+pin|code\\s+secret)\\b[^.]{0,40}?${ANNONCE}`,
      "i",
    ),
  },
  {
    category: "cle-api",
    pattern: new RegExp(
      `\\b(cl[ée]\\s+(d')?api|api\\s*key|token\\s+d'acc[èe]s|access\\s+token|jeton)\\b[^.]{0,40}?${ANNONCE}`,
      "i",
    ),
  },
  {
    category: "phrase-de-recuperation",
    pattern:
      /\b(seed\s+phrase|phrase\s+de\s+r[ée]cup[ée]ration|mn[ée]monique|recovery\s+phrase)\b/i,
  },
  { category: "cryptogramme", pattern: /\b(cvv|cvc|cryptogramme)\b[^.]{0,20}\d{3,4}\b/i },
];

/**
 * Numéro de carte bancaire.
 *
 * Une expression seule dirait « treize à dix-neuf chiffres » et refuserait aussi
 * un ISBN, un numéro de commande, une référence de colis — des choses qu'un
 * utilisateur a de bonnes raisons de vouloir retenir.
 *
 * La clé de Luhn tranche : elle est vraie pour toutes les cartes émises et
 * fausse pour neuf suites de chiffres sur dix. Le test coûte huit lignes et
 * transforme une règle grossière en règle défendable.
 */
function looksLikeCardNumber(content: string): boolean {
  for (const candidate of content.match(/\b(?:\d[ -]?){12,18}\d\b/g) ?? []) {
    const digits = candidate.replace(/[^0-9]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

/** Ce qui exige un accord explicite. */
const PERSONAL: { category: string; pattern: RegExp }[] = [
  {
    category: "sante",
    pattern:
      // Des **radicaux**, pas des mots entiers : « diagnostiqué » ne contient
      // pas « diagnostic », et « diabétique » ne contient pas « diabète ». Une
      // liste de formes fléchies serait toujours incomplète, et le mot manquant
      // serait précisément celui qu'on voulait protéger.
      /\b(diagnosti|maladie|traitement|ordonnance|m[ée]dicament|allergi|d[ée]pressi|cancer|diab[èe]t|s[ée]roposit|grossesse|handicap|th[ée]rapi|psychiatr|hospitalis|sympt[ôo]me|chimioth[ée]rapi)/i,
  },
  {
    category: "finance",
    pattern:
      /\b(iban|bic|swift|num[ée]ro\s+de\s+compte|rib|salaire|revenu|dette|cr[ée]dit\s+immobilier|d[ée]couvert)\b/i,
  },
  {
    category: "identite",
    pattern:
      /\b(num[ée]ro\s+de\s+s[ée]curit[ée]\s+sociale|nir|passeport|carte\s+d'identit[ée]|permis\s+de\s+conduire|social\s+security)\b/i,
  },
  {
    category: "adresse",
    pattern: /\b\d{1,4}\s+(rue|avenue|boulevard|impasse|all[ée]e|chemin|place)\s+[a-zà-ÿ]/i,
  },
  {
    category: "orientation-croyance",
    pattern: /\b(religion|croyance|orientation\s+sexuelle|parti\s+politique|syndicat)\b/i,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classe un contenu candidat.
 *
 * `redactText` de `@nexus/shared` sert de premier filtre : s'il modifie le
 * texte, c'est qu'il y a reconnu un secret de forme connue — jeton, clé privée,
 * URL avec identifiants. Réutiliser ce détecteur plutôt que d'en écrire un
 * second évite qu'ils divergent, et tout ce qu'on apprend à masquer dans les
 * journaux profite aussitôt à la mémoire.
 */
export function classify(content: string): Classification {
  const categories: string[] = [];

  if (redactText(content) !== content) {
    categories.push("secret-reconnaissable");
  }

  for (const { category, pattern } of FORBIDDEN) {
    if (pattern.test(content)) categories.push(category);
  }

  if (looksLikeCardNumber(content)) categories.push("carte-bancaire");

  if (categories.length > 0) {
    return {
      verdict: "FORBIDDEN",
      categories,
      explanation:
        "Ce contenu ressemble à un secret d'authentification ou à un moyen de paiement. " +
        "NEXUS ne le mémorisera pas : ce n'est pas un coffre-fort, et l'y déposer donnerait " +
        "une fausse impression de sécurité. Utilisez un gestionnaire de mots de passe.",
    };
  }

  for (const { category, pattern } of PERSONAL) {
    if (pattern.test(content)) categories.push(category);
  }

  if (categories.length > 0) {
    return {
      verdict: "PERSONAL",
      categories,
      explanation:
        `Ce souvenir touche à une information personnelle (${categories.join(", ")}). ` +
        "NEXUS peut la retenir, mais seulement si vous le confirmez.",
    };
  }

  return { verdict: "ORDINARY", categories: [], explanation: "" };
}

/**
 * Aperçu masqué d'un contenu refusé.
 *
 * Il faut bien dire *quelque chose* à l'utilisateur — « votre demande a été
 * refusée » sans plus est inutilisable. Mais l'aperçu passe par `redactText`, et
 * la partie qui a déclenché le refus n'y figure jamais telle quelle.
 */
export function safePreview(content: string, maxChars = 60): string {
  const masked = redactText(content).replace(/\s+/g, " ").trim();
  return masked.length <= maxChars ? masked : `${masked.slice(0, maxChars)}…`;
}
