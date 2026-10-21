/**
 * Secret redaction.
 *
 * Applied before any object enters an execution trace, an event, or a log.
 * The matching strategy is intentionally comprehensive: failing to redact
 * a secret is far more costly than an occasional over-redaction.
 *
 * Two complementary levels:
 *   - by key NAME (`password`, `apiKey`, `authorization`, etc.);
 *   - by value SHAPE (`sk-...`, `ghp_...`, JWTs), because secrets frequently
 *     arrive in fields innocently named `value` or `content`.
 */

const SECRET_KEY_PATTERN =
  /^(pass(word)?|pwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|session|private[_-]?key|master[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI/Anthropic-style API keys
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /^Bearer\s+\S{16,}$/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const REDACTED = "[REDACTED]";

function looksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Deep copy of a value with secrets redacted.
 *
 * `maxDepth` bounds recursion: cyclical or deeply nested structures must
 * never crash telemetry and logging pipelines.
 */
export function redact(value: unknown, maxDepth = 8): unknown {
  return redactAt(value, maxDepth, new WeakSet());
}

function redactAt(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return looksSecret(value) ? REDACTED : redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return "[max depth reached]";

  if (seen.has(value)) return "[circular reference]";
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

/** Truncates text intended for traces, previews, or logs. */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}… [truncated, ${String(text.length)} characters]`;
}

/**
 * Inline secret patterns searched within free-form text.
 *
 * Specific formats (sk-, ghp-, JWT) run first; generic key=value patterns run last
 * to avoid masking prefixes while leaving credentials exposed.
 */
const INLINE_SECRET_PATTERNS: { pattern: RegExp; replace: (match: string) => string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REDACTED },
  {
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    replace: () => REDACTED,
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replace: () => `Bearer ${REDACTED}` },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi,
    replace: (match) => match.replace(/:([^\s@]+)@/, `:${REDACTED}@`),
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => REDACTED,
  },
  {
    pattern:
      /[A-Za-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(\s*[:=]\s*)("?)([^\s"',;]{4,})\2/gi,
    replace: (match) => match.replace(/([:=]\s*"?)([^\s"',;]{4,})/, `$1${REDACTED}`),
  },
];

/** Redacts secrets found in free-form string content. */
export function redactText(text: string): string {
  let output = text;
  for (const { pattern, replace } of INLINE_SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => replace(match));
  }
  return output;
}
