import { redactText } from "@nexus/shared";

/**
 * Classification of proposed memory content.
 *
 * The core rule is: **nothing sensitive is stored silently.**
 * This is governed by three deterministic verdicts:
 *
 *  - `FORBIDDEN` — **never**, regardless of request origin. Passwords, API keys,
 *    tokens, recovery phrases, credit card numbers. NEXUS is not a password manager:
 *    it provides neither dedicated encryption-at-rest nor key rotation or revocation.
 *    Accepting these items creates a false sense of security. Users must be redirected
 *    to dedicated secret stores.
 *
 *  - `PERSONAL` — **with explicit user agreement**. Health, finance, identity numbers,
 *    exact street addresses. Legitimate facts to remember, but the caller must supply
 *    `acknowledgedSensitive: true` after explicit confirmation.
 *
 *  - `ORDINARY` — standard facts, preferences, and details.
 *
 * Detection is deterministic rather than delegated to an LLM, and deliberately conservative:
 * a false refusal costs a slight rephrase; a false acceptance leaks credentials.
 */

export type SensitivityVerdict = "ORDINARY" | "PERSONAL" | "FORBIDDEN";

export interface Classification {
  verdict: SensitivityVerdict;
  /** Recognized category slugs. Never raw content excerpts. */
  categories: string[];
  /** Human-readable explanation suitable for display. */
  explanation: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connective phrasing following credential declarations.
 */
const ANNONCE = "(?:\\b(?:est|sont|c'est|vaut|is|are|was)\\b|[:=])";

const FORBIDDEN: { category: string; pattern: RegExp }[] = [
  {
    category: "mot-de-passe",
    pattern: new RegExp(
      `\\b(mot\\s+de\\s+passe|motdepasse|mdp|password|passphrase|code\\s+pin|pin\\s+code|code\\s+secret|secret\\s+code)\\b[^.]{0,40}?${ANNONCE}`,
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
  {
    category: "cryptogramme",
    pattern: /\b(cvv|cvc|cryptogramme|security\s+code)\b[^.]{0,20}\d{3,4}\b/i,
  },
];

/**
 * Credit card number detector backed by Luhn algorithm verification.
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

/** Content requiring explicit user acknowledgment. */
const PERSONAL: { category: string; pattern: RegExp }[] = [
  {
    category: "sante",
    pattern:
      /\b(diagnosti|maladie|traitement|ordonnance|m[ée]dicament|allergi|d[ée]pressi|cancer|diab[èe]t|s[ée]roposit|grossesse|handicap|th[ée]rapi|psychiatr|hospitalis|sympt[ôo]me|chimioth[ée]rapi|illness|disease|treatment|prescription|medication|allergy|depression|diabetes|pregnancy|disability|therapy|psychiatry|hospital|symptom|chemotherapy)/i,
  },
  {
    category: "finance",
    pattern:
      /\b(iban|bic|swift|num[ée]ro\s+de\s+compte|account\s+number|rib|salaire|salary|revenu|income|dette|debt|cr[ée]dit\s+immobilier|mortgage|d[ée]couvert|overdraft)\b/i,
  },
  {
    category: "identite",
    pattern:
      /\b(num[ée]ro\s+de\s+s[ée]curit[ée]\s+sociale|social\s+security|nir|passeport|passport|carte\s+d'identit[ée]|id\s+card|permis\s+de\s+conduire|driver'?s\s+license)\b/i,
  },
  {
    category: "adresse",
    pattern:
      /\b\d{1,4}\s+(rue|avenue|boulevard|impasse|all[ée]e|chemin|place|street|road|lane|drive|way)\s+[a-zà-ÿ0-9]/i,
  },
  {
    category: "orientation-croyance",
    pattern:
      /\b(religion|croyance|orientation\s+sexuelle|parti\s+politique|syndicat|belief|sexual\s+orientation|political\s+party|trade\s+union)\b/i,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies candidate memory content.
 *
 * Uses `redactText` as a first filter: if recognized credentials, tokens, or private keys
 * are found, the content is classified as FORBIDDEN immediately.
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
        "This content resembles an authentication secret or payment method. " +
        "NEXUS will not store it: it is not a password manager, and storing it here creates " +
        "a false sense of security. Use a dedicated password manager.",
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
        `This memory touches upon personal information (${categories.join(", ")}). ` +
        "NEXUS can retain it, but only if you explicitly confirm.",
    };
  }

  return { verdict: "ORDINARY", categories: [], explanation: "" };
}

/**
 * Masked preview of rejected content for safe user feedback.
 */
export function safePreview(content: string, maxChars = 60): string {
  const masked = redactText(content).replace(/\s+/g, " ").trim();
  return masked.length <= maxChars ? masked : `${masked.slice(0, maxChars)}…`;
}
