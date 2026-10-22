import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { uuidv7, AppError, type ErrorSeverity } from "@nexus/shared";
import {
  type TokenService,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParams,
} from "@nexus/auth";
import type { SessionStore, User, UserStore } from "./stores.js";

/**
 * Sign in, token refresh, sign out.
 *
 * Two tokens, two distinct roles:
 *
 *  - a short-lived (fifteen minutes) **access token**, signed, sent on each request.
 *    It is stored nowhere: the server verifies it by signature;
 *  - a long-lived **refresh token**, where only the hash is
 *    retained, and which **rotates on every use**.
 *
 * Rotation makes token theft detectable: if a previously consumed
 * refresh token is presented again, it indicates it was copied. We then revoke
 * **the user's entire session family**, not just that one
 * — both the attacker and victim hold a token, and we cannot tell which
 * is which.
 */

export class InvalidCredentialsError extends AppError {
  readonly code = "INVALID_CREDENTIALS";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor() {
    super({
      message: "Invalid credentials",
      // A single message for "unknown address" and "wrong password":
      // distinguishing them would reveal which addresses have an account.
      userMessage: "Incorrect email or password.",
    });
  }
}

export class SessionRevokedError extends AppError {
  readonly code = "SESSION_REVOKED";
  readonly httpStatus = 401;

  constructor(reason: string) {
    super({
      message: `Session revoked: ${reason}`,
      userMessage: "Your session was closed. Please sign in again.",
      context: { reason },
    });
  }
}

export interface AuthTokens {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthServiceOptions {
  users: UserStore;
  sessions: SessionStore;
  tokens: TokenService;
  /** Lifespan of a refresh token. */
  refreshTtlMs?: number;
  /**
   * Hashing cost. **Reduced in tests only**: a suite that spends
   * 350 ms per account created ends up not being run.
   */
  passwordParams?: ScryptParams;
  now?: () => Date;
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  readonly #users: UserStore;
  readonly #sessions: SessionStore;
  readonly #tokens: TokenService;
  readonly #refreshTtlMs: number;
  readonly #passwordParams: ScryptParams | undefined;
  readonly #now: () => Date;

  constructor(options: AuthServiceOptions) {
    this.#users = options.users;
    this.#sessions = options.sessions;
    this.#tokens = options.tokens;
    this.#refreshTtlMs = options.refreshTtlMs ?? 30 * 24 * 60 * 60_000;
    this.#passwordParams = options.passwordParams;
    this.#now = options.now ?? (() => new Date());
  }

  async register(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<{ user: User; tokens: AuthTokens }> {
    const passwordHash = await this.#hash(input.password);
    const user = await this.#users.create({
      email: input.email,
      displayName: input.displayName,
      passwordHash,
    });

    return { user, tokens: await this.#openSession(user.id) };
  }

  /**
   * Sign in.
   *
   * The password is verified **even when the email address is unknown**, against
   * a decoy hash. Otherwise, an immediate response signals "this account
   * does not exist" and enables username enumeration.
   */
  async login(input: { email: string; password: string }): Promise<{
    user: User;
    tokens: AuthTokens;
  }> {
    const record = await this.#users.findByEmail(input.email);

    if (record === undefined) {
      await verifyPassword(input.password, DECOY_HASH);
      throw new InvalidCredentialsError();
    }

    const valid = await verifyPassword(input.password, record.passwordHash);
    if (!valid) throw new InvalidCredentialsError();

    if (record.status !== "ACTIVE") {
      throw new SessionRevokedError("account suspended");
    }

    // Parameter hardening is updated on next login without
    // requiring the user to change their password.
    if (needsRehash(record.passwordHash)) {
      await this.#users.updatePasswordHash(record.id, await this.#hash(input.password));
    }

    const { passwordHash: _hash, ...user } = record;
    return { user, tokens: await this.#openSession(user.id) };
  }

  /**
   * Refreshes a session by rotating the refresh token.
   *
   * @throws {SessionRevokedError} if the presented token was already consumed —
   *   indicating it was copied. All sessions for the user are then
   *   closed: there is no way to distinguish the attacker from the victim.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const session = await this.#sessions.findByRefreshHash(hashRefreshToken(refreshToken));
    if (session === undefined) throw new SessionRevokedError("unknown token");

    const now = this.#now();

    if (session.revokedAt !== null) {
      await this.#sessions.revokeAllForUser(session.userId, now);
      throw new SessionRevokedError("replayed refresh token");
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new SessionRevokedError("session expired");
    }

    await this.#sessions.revoke(session.id, now);
    return this.#openSession(session.userId);
  }

  async logout(sessionId: string): Promise<void> {
    await this.#sessions.revoke(sessionId, this.#now());
  }

  async logoutAll(userId: string): Promise<number> {
    return this.#sessions.revokeAllForUser(userId, this.#now());
  }

  /**
   * Verifies that a session is still active.
   *
   * The access token carries its own signature, but that is insufficient: a
   * logout must take effect immediately, including on a token that is still
   * cryptographically valid.
   */
  async assertSessionActive(sessionId: string): Promise<void> {
    const session = await this.#sessions.get(sessionId);
    if (session === undefined) throw new SessionRevokedError("unknown session");
    if (session.revokedAt !== null) throw new SessionRevokedError("session closed");
    if (session.expiresAt.getTime() <= this.#now().getTime()) {
      throw new SessionRevokedError("session expired");
    }
  }

  #hash(password: string): Promise<string> {
    return this.#passwordParams === undefined
      ? hashPassword(password)
      : hashPassword(password, this.#passwordParams);
  }

  async #openSession(userId: string): Promise<AuthTokens> {
    const now = this.#now();
    const sessionId = uuidv7();
    const refreshToken = randomBytes(32).toString("base64url");
    const refreshExpiresAt = new Date(now.getTime() + this.#refreshTtlMs);

    await this.#sessions.create({
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt: refreshExpiresAt,
      revokedAt: null,
      refreshTokenHash: hashRefreshToken(refreshToken),
    });

    const access = this.#tokens.issueAccessToken({ userId, sessionId });

    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken,
      refreshExpiresAt,
    };
  }
}

/**
 * Decoy hash with current parameters.
 *
 * Verified when the email address is unknown, solely so the response takes
 * the same duration. The password that produced it is irrelevant; what
 * matters is that the computation is identical.
 */
const DECOY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$" +
  "d2VfZG9fbm90X2NhcmVfYWJvdXRfdGhpc192YWx1ZV9hdF9hbGxfaXRfaXNfYV9kZWNveV8xMjM0";

/** Constant-time comparison for opaque tokens. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
