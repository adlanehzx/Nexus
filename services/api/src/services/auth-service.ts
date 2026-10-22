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
 * Connexion, rafraîchissement, déconnexion.
 *
 * Deux jetons, deux rôles distincts :
 *
 *  - un **jeton d'accès** court (quinze minutes), signé, porté à chaque requête.
 *    Il n'est stocké nulle part : le serveur le vérifie par la signature ;
 *  - un **jeton de rafraîchissement** long, dont seule l'empreinte est
 *    conservée, et qui **tourne à chaque usage**.
 *
 * La rotation est ce qui rend le vol détectable : si un jeton de
 * rafraîchissement déjà consommé réapparaît, c'est qu'il a été copié. On révoque
 * alors **toute la famille de sessions de l'utilisateur**, pas seulement celle-là
 * — l'attaquant et la victime en détiennent chacun un, et on ne sait pas lequel
 * est lequel.
 */

export class InvalidCredentialsError extends AppError {
  readonly code = "INVALID_CREDENTIALS";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor() {
    super({
      message: "Identifiants refusés",
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
      message: `Session révoquée : ${reason}`,
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
  /** Durée de vie d'un jeton de rafraîchissement. */
  refreshTtlMs?: number;
  /**
   * Coût du hachage. **Réduit dans les tests uniquement** : une suite qui paie
   * 350 ms par compte créé finit par ne plus être lancée.
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
   * Connexion.
   *
   * Le mot de passe est vérifié **même quand l'adresse est inconnue**, contre
   * une empreinte factice. Sans cela, une réponse immédiate signale « ce compte
   * n'existe pas » et permet d'énumérer les adresses enregistrées.
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
      throw new SessionRevokedError("compte suspendu");
    }

    // Le durcissement des paramètres se rattrape à la connexion suivante, sans
    // que l'utilisateur ait à changer de mot de passe.
    if (needsRehash(record.passwordHash)) {
      await this.#users.updatePasswordHash(record.id, await this.#hash(input.password));
    }

    const { passwordHash: _hash, ...user } = record;
    return { user, tokens: await this.#openSession(user.id) };
  }

  /**
   * Rafraîchit une session, en faisant tourner le jeton.
   *
   * @throws {SessionRevokedError} si le jeton présenté a déjà été consommé —
   *   signe qu'il a été copié. Toutes les sessions de l'utilisateur sont alors
   *   fermées : on ne peut pas savoir qui, de l'attaquant ou de la victime,
   *   présente le jeton.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const session = await this.#sessions.findByRefreshHash(hashRefreshToken(refreshToken));
    if (session === undefined) throw new SessionRevokedError("jeton inconnu");

    const now = this.#now();

    if (session.revokedAt !== null) {
      await this.#sessions.revokeAllForUser(session.userId, now);
      throw new SessionRevokedError("jeton de rafraîchissement rejoué");
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new SessionRevokedError("session expirée");
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
   * Vérifie qu'une session est toujours ouverte.
   *
   * Le jeton d'accès porte sa propre signature, mais cela ne suffit pas : une
   * déconnexion doit prendre effet immédiatement, y compris sur un jeton encore
   * valide cryptographiquement.
   */
  async assertSessionActive(sessionId: string): Promise<void> {
    const session = await this.#sessions.get(sessionId);
    if (session === undefined) throw new SessionRevokedError("session inconnue");
    if (session.revokedAt !== null) throw new SessionRevokedError("session fermée");
    if (session.expiresAt.getTime() <= this.#now().getTime()) {
      throw new SessionRevokedError("session expirée");
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
 * Empreinte factice, aux paramètres courants.
 *
 * Vérifiée quand l'adresse est inconnue, uniquement pour que la réponse mette
 * le même temps. Le mot de passe qui l'a produite n'a aucune importance ; ce qui
 * compte est que le calcul soit identique.
 */
const DECOY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$" +
  "d2VfZG9fbm90X2NhcmVfYWJvdXRfdGhpc192YWx1ZV9hdF9hbGxfaXRfaXNfYV9kZWNveV8xMjM0";

/** Comparaison en temps constant, pour les jetons opaques. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
