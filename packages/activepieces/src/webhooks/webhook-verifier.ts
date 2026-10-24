import crypto from "node:crypto";

export class WebhookSecurityError extends Error {
  readonly code: string;
  constructor(message: string, code = "WEBHOOK_SECURITY_ERROR") {
    super(message);
    this.name = "WebhookSecurityError";
    this.code = code;
  }
}

export interface WebhookVerificationOptions {
  secret: string;
  toleranceSeconds?: number | undefined; // Default 300s (5 mins)
}

export class SignedWebhookVerifier {
  private readonly secret: string;
  private readonly toleranceSeconds: number;
  private readonly seenNonces = new Map<string, number>(); // nonce -> timestamp

  constructor(options: WebhookVerificationOptions) {
    if (!options.secret || options.secret.length < 16) {
      throw new WebhookSecurityError("Webhook secret must be at least 16 characters long");
    }
    this.secret = options.secret;
    this.toleranceSeconds = options.toleranceSeconds ?? 300;
  }

  /**
   * Generates a signed webhook header payload with timestamp, nonce, and HMAC-SHA256 signature.
   */
  signPayload(
    payloadString: string,
    timestamp = Math.floor(Date.now() / 1000),
  ): {
    signatureHeader: string;
    nonce: string;
    timestamp: number;
  } {
    const nonce = crypto.randomBytes(16).toString("hex");
    const signatureContent = `${timestamp}.${nonce}.${payloadString}`;
    const hmac = crypto.createHmac("sha256", this.secret).update(signatureContent).digest("hex");
    const signatureHeader = `t=${timestamp},n=${nonce},v1=${hmac}`;

    return { signatureHeader, nonce, timestamp };
  }

  /**
   * Verifies incoming webhook request headers and payload against HMAC signature,
   * timestamp freshness, and replay attacks.
   */
  verifyWebhook(
    payloadString: string,
    signatureHeader: string,
    currentTimestamp = Math.floor(Date.now() / 1000),
  ): { verified: boolean; timestamp: number; nonce: string } {
    if (!signatureHeader) {
      throw new WebhookSecurityError("Missing webhook signature header", "MISSING_SIGNATURE");
    }

    // Parse header: t=...,n=...,v1=...
    const parts = signatureHeader.split(",");
    let t: number | undefined;
    let nonce: string | undefined;
    let v1: string | undefined;

    for (const part of parts) {
      const [k, v] = part.split("=");
      if (k === "t" && v) t = parseInt(v, 10);
      else if (k === "n" && v) nonce = v;
      else if (k === "v1" && v) v1 = v;
    }

    if (!t || !nonce || !v1) {
      throw new WebhookSecurityError(
        "Malformed webhook signature header format",
        "MALFORMED_HEADER",
      );
    }

    // 1. Anti-replay: Timestamp window validation
    const age = currentTimestamp - t;
    if (Math.abs(age) > this.toleranceSeconds) {
      throw new WebhookSecurityError(
        `Webhook timestamp expired or out of allowed window (age: ${age}s, max tolerance: ${this.toleranceSeconds}s)`,
        "TIMESTAMP_EXPIRED",
      );
    }

    // 2. Anti-replay: Nonce check
    this.cleanupNonces(currentTimestamp);
    if (this.seenNonces.has(nonce)) {
      throw new WebhookSecurityError(
        `Replay attack detected: nonce '${nonce}' has already been processed`,
        "REPLAY_DETECTED",
      );
    }

    // 3. HMAC-SHA256 constant-time comparison
    const signatureContent = `${t}.${nonce}.${payloadString}`;
    const expectedHmac = crypto
      .createHmac("sha256", this.secret)
      .update(signatureContent)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedHmac, "hex");
    const receivedBuffer = Buffer.from(v1, "hex");

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      throw new WebhookSecurityError("Invalid webhook HMAC signature", "INVALID_SIGNATURE");
    }

    // Record nonce
    this.seenNonces.set(nonce, currentTimestamp);

    return { verified: true, timestamp: t, nonce };
  }

  private cleanupNonces(now: number): void {
    for (const [nonce, ts] of this.seenNonces.entries()) {
      if (now - ts > this.toleranceSeconds * 2) {
        this.seenNonces.delete(nonce);
      }
    }
  }
}
