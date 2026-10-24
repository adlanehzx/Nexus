import crypto from "node:crypto";

export class VisualSecurityError extends Error {
  readonly code: string;
  constructor(message: string, code = "VISUAL_SECURITY_ERROR") {
    super(message);
    this.name = "VisualSecurityError";
    this.code = code;
  }
}

const VISUAL_PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s+prompt\s+override/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /assistant:\s*always\s+comply/i,
  /execute\s+this\s+command\s+immediately/i,
  /bypass\s+security\s+sandbox/i,
];

const DESTRUCTIVE_ACTIONS_PATTERNS = [
  /\b(rm\s+-rf|del\s+\/f|format\s+[a-z]:|mkfs|dd\s+if=)/i,
  /\b(drop\s+database|truncate\s+table)\b/i,
  /\b(killall|pkill\s+-9)\b/i,
  /\b(sudo|chmod\s+777|chown\s+-R)\b/i,
];

export interface ScreenshotMetadata {
  hash: string;
  capturedAt: number;
  width: number;
  height: number;
}

export class VisualSecurityGuard {
  private readonly maxScreenshotAgeMs: number;

  constructor(options?: { maxScreenshotAgeMs?: number }) {
    this.maxScreenshotAgeMs = options?.maxScreenshotAgeMs ?? 10_000; // 10s default freshness TTL
  }

  /**
   * Generates a tamper-proof timestamped hash for a screenshot.
   */
  fingerprintScreenshot(image: Buffer | string, width: number, height: number): ScreenshotMetadata {
    const rawBuffer = typeof image === "string" ? Buffer.from(image, "base64") : image;
    const hash = crypto.createHash("sha256").update(rawBuffer).digest("hex");
    return {
      hash,
      capturedAt: Date.now(),
      width,
      height,
    };
  }

  /**
   * Asserts that a screenshot is fresh and not stale.
   * Throws VisualSecurityError if older than maxScreenshotAgeMs.
   */
  assertFreshScreenshot(metadata: ScreenshotMetadata, currentTimestamp = Date.now()): void {
    const ageMs = currentTimestamp - metadata.capturedAt;
    if (ageMs > this.maxScreenshotAgeMs) {
      throw new VisualSecurityError(
        `Stale screenshot rejected: age is ${Math.round(ageMs / 1000)}s (max allowed is ${Math.round(this.maxScreenshotAgeMs / 1000)}s)`,
        "STALE_SCREENSHOT",
      );
    }
  }

  /**
   * Scans extracted visual/OCR text for visual prompt injection attacks.
   */
  assertNoVisualPromptInjection(text: string): void {
    for (const pattern of VISUAL_PROMPT_INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        throw new VisualSecurityError(
          `Visual prompt injection detected in screen content matching pattern: ${pattern.source}`,
          "VISUAL_PROMPT_INJECTION",
        );
      }
    }
  }

  /**
   * Checks whether an action or text input is destructive and requires human confirmation.
   */
  isDestructiveAction(actionPayload: string): boolean {
    return DESTRUCTIVE_ACTIONS_PATTERNS.some((pattern) => pattern.test(actionPayload));
  }

  /**
   * Asserts that destructive native actions must have explicit confirmation.
   */
  assertNativeActionPermitted(actionPayload: string, confirmedByHuman: boolean): void {
    if (this.isDestructiveAction(actionPayload) && !confirmedByHuman) {
      throw new VisualSecurityError(
        `Destructive native action requires explicit user confirmation: "${actionPayload}"`,
        "CONFIRMATION_REQUIRED",
      );
    }
  }
}
