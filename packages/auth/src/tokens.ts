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
 * Émission et vérification des jetons.
 *
 * **EdDSA (Ed25519), et non un secret partagé.** La raison est structurelle :
 * plusieurs composants doivent vérifier un jeton — l'API REST, la passerelle
 * WebSocket, et demain un service séparé — alors qu'un seul doit pouvoir en
 * émettre. Avec un secret symétrique, tout ce qui vérifie peut aussi forger.
 *
 * Le format est un JWS compact ordinaire (`en-tête.charge.signature`), ce qui
 * évite d'inventer une sérialisation et rend les jetons inspectables avec les
 * outils habituels.
 */

export class TokenInvalidError extends AppError {
  readonly code = "TOKEN_INVALID";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Jeton refusé : ${reason}`,
      userMessage: "Invalid or expired session. Please sign in again.",
      context: { reason },
    });
  }
}

export class TokenExpiredError extends AppError {
  readonly code = "TOKEN_EXPIRED";
  readonly httpStatus = 401;
  override readonly severity: ErrorSeverity = "warning";
  // Réessayable au sens du client : rafraîchir le jeton suffit.
  override readonly retryable = true;

  constructor() {
    super({
      message: "Jeton expiré",
      userMessage: "Your session has expired. Please sign in again.",
    });
  }
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

const fromBase64url = (input: string): Buffer => Buffer.from(input, "base64url");

const HEADER = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));

/**
 * Audience des assertions de mission.
 *
 * Constante et non configurable : c'est une frontière de privilèges, pas un
 * réglage de déploiement. La rendre paramétrable permettrait de la faire
 * coïncider par erreur avec l'audience des jetons d'accès, et d'effacer
 * silencieusement la séparation que cette valeur existe pour tenir.
 */
export const MISSION_GRANT_AUDIENCE = "nexus-mission-grant";

/**
 * Audience des jetons destinés à Mission Engine.
 *
 * Constante, comme celle des assertions, et pour la même raison : c'est une
 * frontière, pas un réglage. La rendre configurable permettrait de la faire
 * coïncider par erreur avec une autre audience et d'effacer la séparation que
 * cette valeur existe pour tenir.
 */
export const MISSION_ENGINE_AUDIENCE = "nexus-mission-engine";

export interface TokenServiceOptions {
  /** Clé privée Ed25519 au format PEM PKCS8. */
  privateKeyPem: string;
  issuer?: string;
  audience?: string;
  /**
   * Durée de vie d'un jeton d'accès.
   *
   * Court par défaut : un jeton volé dans un journal ou un cache de proxy ne
   * doit pas rester utile longtemps. Le rafraîchissement est bon marché.
   */
  accessTtlSeconds?: number;
  deviceTtlSeconds?: number;
  /**
   * Durée de vie d'une assertion de mission.
   *
   * Plus longue qu'un jeton d'accès — une mission multi-agents peut tourner des
   * heures et doit survivre à un redémarrage — mais bornée : une assertion
   * oubliée dans la base du moteur cesse d'ouvrir quoi que ce soit au bout
   * d'une journée, et une mission plus longue se fait renouveler sa portée.
   */
  missionGrantTtlSeconds?: number;
  /**
   * Durée de vie d'un jeton de service.
   *
   * Deux minutes : assez pour couvrir une horloge légèrement désynchronisée et
   * un appel lent, trop peu pour qu'un jeton capté dans un journal serve à
   * quoi que ce soit.
   */
  serviceTtlSeconds?: number;
  now?: () => Date;
}

/** Paire de clés de signature. Générée à l'appairage d'un déploiement. */
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

  /** Clé publique, pour un vérificateur qui ne doit pas pouvoir émettre. */
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

  /**
   * Émet une assertion de mission pour un service.
   *
   * Appelée au moment où un utilisateur authentifié confie une mission au
   * moteur : c'est **l'API qui signe**, jamais le moteur. Mission Engine ne
   * détient donc aucun pouvoir d'émission — il conserve une assertion opaque et
   * la rejoue. Compromettre sa base SQLite n'apprend pas à en forger une autre,
   * et ne donne accès qu'aux missions qui y figurent, jusqu'à leur expiration.
   */
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

  /**
   * Vérifie une assertion de mission.
   *
   * L'audience dédiée est ce qui empêche la confusion de surfaces : un jeton
   * d'accès utilisateur porte `nexus-api` et échoue ici, une assertion porte
   * `nexus-mission-grant` et échoue dans `verifyAccessToken`. Aucun des deux
   * ne peut tenir le rôle de l'autre, même signé par la même clé.
   *
   * @throws {TokenInvalidError} signature, forme, émetteur ou audience refusés.
   * @throws {TokenExpiredError} assertion périmée.
   */
  verifyMissionGrant(token: string): MissionGrantClaims {
    const payload = this.#verify(token);
    const claims = missionGrantClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("claims de mission malformés");

    if (claims.data.iss !== this.#issuer) throw new TokenInvalidError("émetteur inattendu");
    if (claims.data.aud !== MISSION_GRANT_AUDIENCE) {
      throw new TokenInvalidError("audience inattendue");
    }
    this.#assertNotExpired(claims.data.exp);

    return claims.data;
  }

  /**
   * Émet un jeton de service, pour un appel sortant vers un autre service.
   *
   * Courte durée de vie : le jeton est émis par appel et n'a aucune raison de
   * survivre à la requête. C'est ce qui dispense d'un registre — là où une
   * assertion de mission vit des heures et doit donc pouvoir être retirée, un
   * jeton de service périmé depuis une minute n'intéresse personne.
   */
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

  /**
   * Vérifie un jeton de service.
   *
   * Présent ici pour que l'émetteur et le vérificateur partagent une seule
   * définition du format, et pour que les tests puissent éprouver le refus sans
   * passer par le service Python. En production c'est bien Mission Engine qui
   * vérifie, avec la clé publique seule.
   */
  verifyServiceToken(token: string, audience: string): ServiceTokenClaims {
    const payload = this.#verify(token);
    const claims = serviceTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("claims de service malformés");

    if (claims.data.iss !== this.#issuer) throw new TokenInvalidError("émetteur inattendu");
    if (claims.data.aud !== audience) throw new TokenInvalidError("audience inattendue");
    this.#assertNotExpired(claims.data.exp);

    return claims.data;
  }

  /**
   * Vérifie un jeton d'accès utilisateur.
   *
   * @throws {TokenInvalidError} signature, forme, émetteur ou audience refusés.
   * @throws {TokenExpiredError} jeton périmé — distingué pour que le client
   *   sache qu'un rafraîchissement suffit, sans redemander le mot de passe.
   */
  verifyAccessToken(token: string): AccessTokenClaims {
    const payload = this.#verify(token);
    const claims = accessTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("claims d'accès malformés");

    if (claims.data.iss !== this.#issuer) throw new TokenInvalidError("émetteur inattendu");
    if (claims.data.aud !== this.#audience) throw new TokenInvalidError("audience inattendue");
    this.#assertNotExpired(claims.data.exp);

    return claims.data;
  }

  verifyDeviceToken(token: string): DeviceTokenClaims {
    const payload = this.#verify(token);
    const claims = deviceTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenInvalidError("claims d'appareil malformés");

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

  /**
   * Vérifie la signature et rend la charge utile décodée.
   *
   * L'en-tête est comparé à celui qu'on émet, en temps constant. Un jeton dont
   * l'en-tête annonce `alg: none` ou un autre algorithme est refusé avant même
   * la vérification — c'est la confusion d'algorithme, et elle se ferme ici.
   */
  #verify(token: string): unknown {
    const parts = token.split(".");
    if (parts.length !== 3) throw new TokenInvalidError("forme de jeton invalide");

    const [header, payload, signature] = parts as [string, string, string];

    const expected = Buffer.from(HEADER);
    const received = Buffer.from(header);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new TokenInvalidError("en-tête ou algorithme inattendu");
    }

    const valid = verifyRaw(
      null,
      Buffer.from(`${header}.${payload}`, "utf8"),
      this.#publicKey,
      fromBase64url(signature),
    );
    if (!valid) throw new TokenInvalidError("signature invalide");

    try {
      return JSON.parse(fromBase64url(payload).toString("utf8")) as unknown;
    } catch {
      throw new TokenInvalidError("charge utile illisible");
    }
  }
}
