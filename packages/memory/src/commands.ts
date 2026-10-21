/**
 * Explicit memory commands.
 *
 * "Remember that..." and "Forget..." do NOT route through a model.
 *
 * Deterministic command recognition:
 *  1. Ensures reliable execution of user intent ("forget my address" immediately purges);
 *  2. Is verifiable and fully testable without LLM non-determinism.
 *
 * Commands are anchored to the beginning of the message using imperative phrasing.
 */

export type MemoryCommand =
  | { kind: "remember"; content: string }
  | { kind: "forget"; target: string; all: boolean };

/**
 * Recognized patterns for "remember".
 * Supports both French and English commands.
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
 * Patterns requesting a total memory wipe ("forget all").
 */
const FORGET_ALL_PATTERNS: RegExp[] = [
  /^\s*(?:oublie|efface|supprime)\s+(?:tout|toute\s+(?:ta|la)\s+m[ée]moire|mes\s+souvenirs)\b/i,
  /^\s*(?:forget|erase|delete)\s+(?:everything|all(?:\s+(?:my|your))?\s*(?:memor(?:y|ies))?)\b/i,
];

/**
 * Recognizes explicit memory commands.
 * Returns `undefined` if the message is regular conversation.
 */
export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  // Check total forget patterns first to avoid capturing "all/tout" as a target substring.
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

/** Strips trailing punctuation to prevent duplicates from punctuation differences. */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?;,\s]+$/u, "");
}
