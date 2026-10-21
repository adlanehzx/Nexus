import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signRaw,
  timingSafeEqual,
  verify as verifyRaw,
  type KeyObject,
} from "node:crypto";
import { AppError, type ErrorSeverity } from "@nexus/shared";
import {
  accessTokenClaimsSchema,
  deviceTokenClaimsSchema,
  missionGrantClaimsSchema,
  serviceTokenClaimsSchema,
  type AccessTokenClaims,
  type DeviceTokenClaims,
  type MissionGrantClaims,
  type ServiceTokenClaims,
} from "./index.js";

/**
 * Token issuance and verification.
 *
 * **EdDSA (Ed25519), not a shared secret.** Multiple components must verify
 * tokens (REST API, WebSocket gateway, internal services), while only the auth
 * service should issue them. Asymmetric keys prevent verifiers from forging tokens.
 *
 * Compact JWS format (`header.payload.signature`).
 */

export class TokenInvalidError extends AppError {
  readonly code = "TOKEN_INVALID";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Token refused: ${reason}`,
      userMessage: "Invalid or expired session. Please sign in again.",
      context: { reason },
    });
  }
}

export class TokenExpiredError extends AppError {
  readonly code = "TOKEN_EXPIRED";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";
  override readonly retryable = true;

  constructor() {
    super({
      message: "Token expired",
      userMessage: "Your session has expired. Please sign in again.",
    });
  }
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

const fromBase64url = (input: string): Buffer => Buffer.from(input, "base64url");

const HEADER = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));

/** Audience for mission grant assertions. */
export const MISSION_GRANT_AUDIENCE = "nexus-mission-grant";

/** Audience for tokens targeting Mission Engine. */
export const MISSION_ENGINE_AUDIENCE = "nexus-mission-engine";

export interface TokenServiceOptions {
  /** Ed25519 private key in PEM PKCS8 format. */
  privateKeyPem: string;
  issuer?: string;
  audience?: string;
  accessTtlSeconds?: number;
  deviceTtlSeconds?: number;
  missionGrantTtlSeconds?: number;
  serviceTtlSeconds?: number;
  now?: () => Date;
}

/** Generates signing key pair. */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export class TokenService {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #accessTtl: number;
  readonly #deviceTtl: number;
  readonly #missionGrantTtl: number;
  readonly #serviceTtl: number;
  readonly #now: () => Date;

  constructor(options: TokenServiceOptions) {
    this.#privateKey = createPrivateKey(options.privateKeyPem);
    this.#publicKey = createPublicKey(this.#privateKey);
    this.#issuer = options.issuer ?? "nexus";
    this.#audience = options.audience ?? "nexus-api";
    this.#accessTtl = options.accessTtlSeconds ?? 15 * 60;
    this.#deviceTtl = options.deviceTtlSeconds ?? 30 * 60;
    this.#missionGrantTtl = options.missionGrantTtlSeconds ?? 24 * 60 * 60;
    this.#serviceTtl = options.serviceTtlSeconds ?? 120;
    this.#now = options.now ?? (() => new Date());
  }

  /** Public key for verifiers that cannot issue tokens. */
  get publicKeyPem(): string {
    return this.#publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  issueAccessToken(input: { userId: string; sessionId: string }): {
    token: string;
    expiresAt: Date;
  } {
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const expiresAt = issuedAt + this.#accessTtl;

    const claims: AccessTokenClaims = {
      sub: input.userId,
      sid: input.sessionId,
      iat: issuedAt,
      exp: expiresAt,
      iss: this.#issuer,
      aud: this.#audience,
    };

    return { token: this.#sign(claims), expiresAt: new Date(expiresAt * 1000) };
  }

  issueDeviceToken(input: { deviceId: string; userId: string; capabilities: readonly string[] }): {
    token: string;
    expiresAt: Date;
  } {
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const expiresAt = issuedAt + this.#deviceTtl;

    const claims: DeviceTokenClaims = {
      sub: input.deviceId,
      userId: input.userId,
      iat: issuedAt,
      exp: expiresAt,
      capabilities: [...input.capabilities],
    };

    return { token: this.#sign(claims), expiresAt: new Date(expiresAt * 1000) };
  }

  issueMissionGrant(input: { userId: string; service: string; missionExternalKey: string }): {
    token: string;
    expiresAt: Date;
    grantId: string;
  } {
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const expiresAt = issuedAt + this.#missionGrantTtl;
    const grantId = randomUUID();

    const claims: MissionGrantClaims = {
      sub: input.userId,
      svc: input.service,
      mek: input.missionExternalKey,
      iat: issuedAt,
      exp: expiresAt,
      iss: this.#issuer,
      aud: MISSION_GRANT_AUDIENCE,
      jti: grantId,
    };

    return { token: this.#sign(claims), expiresAt: new Date(expiresAt * 1000), grantId };
  }

  verifyMissionGrant(token: string): MissionGrantClaims {
    const payload = this.#verify(token);
    const claims = missionGrantClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("malformed mission claims");

    if (claims.data.iss !== this.#issuer) throw new TokenInvalidError("unexpected issuer");
    if (claims.data.aud !== MISSION_GRANT_AUDIENCE) {
      throw new TokenInvalidError("unexpected audience");
    }
    this.#assertNotExpired(claims.data.exp);

    return claims.data;
  }

  issueServiceToken(input: { service: string; audience: string }): {
    token: string;
    expiresAt: Date;
  } {
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const expiresAt = issuedAt + this.#serviceTtl;

    const claims: ServiceTokenClaims = {
      sub: input.service,
      iat: issuedAt,
      exp: expiresAt,
      iss: this.#issuer,
      aud: input.audience,
      jti: randomUUID(),
    };

    return { token: this.#sign(claims), expiresAt: new Date(expiresAt * 1000) };
  }

  verifyServiceToken(token: string, audience: string): ServiceTokenClaims {
    const payload = this.#verify(token);
    const claims = serviceTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("malformed service claims");

    if (claims.data.iss !== this.#issuer) throw new TokenInvalidError("unexpected issuer");
    if (claims.data.aud !== audience) throw new TokenInvalidError("unexpected audience");
    this.#assertNotExpired(claims.data.exp);

    return claims.data;
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const payload = this.#verify(token);
    const claims = accessTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("malformed access claims");

    if (claims.data.iss !== this.#issuer) throw new TokenInvalidError("unexpected issuer");
    if (claims.data.aud !== this.#audience) throw new TokenInvalidError("unexpected audience");
    this.#assertNotExpired(claims.data.exp);

    return claims.data;
  }

  verifyDeviceToken(token: string): DeviceTokenClaims {
    const payload = this.#verify(token);
    const claims = deviceTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("malformed device claims");

    this.#assertNotExpired(claims.data.exp);
    return claims.data;
  }

  #assertNotExpired(exp: number): void {
    if (exp * 1000 <= this.#now().getTime()) throw new TokenExpiredError();
  }

  #sign(claims: object): string {
    const payload = base64url(JSON.stringify(claims));
    const signingInput = `${HEADER}.${payload}`;
    const signature = signRaw(null, Buffer.from(signingInput, "utf8"), this.#privateKey);

    return `${signingInput}.${base64url(signature)}`;
  }

  #verify(token: string): unknown {
    const parts = token.split(".");
    if (parts.length !== 3) throw new TokenInvalidError("invalid token format");

    const [header, payload, signature] = parts as [string, string, string];

    const expected = Buffer.from(HEADER);
    const received = Buffer.from(header);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new TokenInvalidError("unexpected header or algorithm");
    }

    const valid = verifyRaw(
      null,
      Buffer.from(`${header}.${payload}`, "utf8"),
      this.#publicKey,
      fromBase64url(signature),
    );
    if (!valid) throw new TokenInvalidError("invalid signature");

    try {
      return JSON.parse(fromBase64url(payload).toString("utf8")) as unknown;
    } catch {
      throw new TokenInvalidError("unreadable payload");
    }
  }
}
