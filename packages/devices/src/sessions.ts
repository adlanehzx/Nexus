import { createHash, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { uuidv7 } from "@nexus/shared";
import { DeviceAuthenticationError, ReplayRejectedError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import { isSessionActive, type DeviceCredential, type DeviceSession } from "./types.js";

/**
 * Sessions d'appareil authentifiées.
 *
 * **Un identifiant d'appareil n'authentifie rien.** Il est public : il apparaît
 * dans l'interface, dans les journaux, dans les événements. L'authentification
 * repose sur un challenge signé par une clé privée qui ne quitte jamais
 * l'appareil, et débouche sur un jeton de session à durée limitée.
 *
 * Ce module fournit le mécanisme. Le transport — WebSocket, HTTP — s'y branche
 * sans le connaître : c'est ce qui permet de le tester intégralement sans
 * ouvrir de connexion.
 */

export interface Challenge {
  deviceId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface AuthenticateInput {
  deviceId: string;
  nonce: string;
  /** Signature du nonce par la clé privée de l'appareil, en base64. */
  signature: string;
  capabilities?: readonly string[];
  remoteAddress?: string;
}

export interface IssuedSession {
  session: DeviceSession;
  /** Rendu **une seule fois**. Seule son empreinte est conservée. */
  token: string;
}

/** Vérifie une signature. Injectable : les tests n'ont pas à faire de crypto. */
export type SignatureVerifier = (
  publicKeyMaterial: string,
  nonce: string,
  signature: string,
) => boolean;

/**
 * Vérificateur Ed25519 par défaut.
 *
 * `publicKeyMaterial` est une clé publique au format PEM SPKI. Toute erreur —
 * clé mal formée, signature illisible — vaut un refus : on ne cherche pas à
 * distinguer les causes d'échec côté appelant.
 */
export const ed25519Verifier: SignatureVerifier = (publicKeyMaterial, nonce, signature) => {
  try {
    return verifySignature(
      null,
      Buffer.from(nonce, "utf8"),
      publicKeyMaterial,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
};

/**
 * Vérificateur ECDSA P-256, en SHA-256.
 *
 * Il existe pour une raison précise : **le magasin de clés d'Android ne gère pas
 * Ed25519.** Un appareil Android qui veut une clé protégée par le matériel — non
 * extractible, éventuellement dans l'enclave — n'a que la courbe P-256 à sa
 * disposition. Le choix est donc entre une clé Ed25519 logicielle et une clé
 * ECDSA adossée au matériel ; la seconde résiste à l'extraction, la première non.
 *
 * La signature est attendue au format DER, celui que produit
 * `Signature.getInstance("SHA256withECDSA")` côté Android.
 *
 * Ce n'est pas un second système d'authentification : le challenge, la session,
 * la rotation et l'anti-rejeu sont exactement les mêmes. Seule change la
 * primitive de vérification, qui était déjà un port.
 */
export const ecdsaP256Verifier: SignatureVerifier = (publicKeyMaterial, nonce, signature) => {
  try {
    return verifySignature(
      "sha256",
      Buffer.from(nonce, "utf8"),
      publicKeyMaterial,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
};

/** Vérificateur correspondant au type de secret enregistré pour l'appareil. */
export function verifierForCredential(kind: DeviceCredential["kind"]): SignatureVerifier {
  return kind === "ECDSA_P256_PUBLIC_KEY" ? ecdsaP256Verifier : ed25519Verifier;
}

export interface DeviceSessionStore {
  save(session: DeviceSession): Promise<void>;
  get(id: string): Promise<DeviceSession | undefined>;
  findByTokenHash(tokenHash: string): Promise<DeviceSession | undefined>;
  listByDevice(deviceId: string): Promise<DeviceSession[]>;
}

export class InMemoryDeviceSessionStore implements DeviceSessionStore {
  readonly #byId = new Map<string, DeviceSession>();

  save(session: DeviceSession): Promise<void> {
    this.#byId.set(session.id, structuredClone(session));
    return Promise.resolve();
  }

  get(id: string): Promise<DeviceSession | undefined> {
    const session = this.#byId.get(id);
    return Promise.resolve(session === undefined ? undefined : structuredClone(session));
  }

  findByTokenHash(tokenHash: string): Promise<DeviceSession | undefined> {
    for (const session of this.#byId.values()) {
      if (session.tokenHash === tokenHash) return Promise.resolve(structuredClone(session));
    }
    return Promise.resolve(undefined);
  }

  listByDevice(deviceId: string): Promise<DeviceSession[]> {
    return Promise.resolve(
      [...this.#byId.values()]
        .filter((session) => session.deviceId === deviceId)
        .map((session) => structuredClone(session)),
    );
  }
}

export interface DeviceSessionServiceOptions {
  registry: DeviceRegistry;
  store?: DeviceSessionStore;
  verifier?: SignatureVerifier;
  /** Durée de vie d'un jeton de session. Court : la rotation est bon marché. */
  sessionTtlMs?: number;
  /** Validité d'un challenge. Court aussi : il ne sert qu'une fois. */
  challengeTtlMs?: number;
  /** Écart d'horloge toléré sur un horodatage de requête. */
  clockSkewMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class DeviceSessionService {
  readonly #registry: DeviceRegistry;
  readonly #store: DeviceSessionStore;
  readonly #verify: SignatureVerifier;
  readonly #sessionTtlMs: number;
  readonly #challengeTtlMs: number;
  readonly #clockSkewMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;

  /** Challenges en cours, consommés à la première utilisation. */
  readonly #challenges = new Map<string, Challenge>();
  /** Nonces déjà vus — protection contre le rejeu. */
  readonly #usedNonces = new Map<string, number>();

  constructor(options: DeviceSessionServiceOptions) {
    this.#registry = options.registry;
    this.#store = options.store ?? new InMemoryDeviceSessionStore();
    this.#verify = options.verifier ?? ed25519Verifier;
    this.#sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
    this.#challengeTtlMs = options.challengeTtlMs ?? 60_000;
    this.#clockSkewMs = options.clockSkewMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
  }

  /**
   * Émet un challenge pour un appareil.
   *
   * Aucun secret partagé de longue durée ne transite : l'appareil prouve qu'il
   * détient sa clé privée en signant ce nonce. Un jeton dérobé dans un journal
   * ne suffit donc pas à se faire passer pour lui.
   */
  async createChallenge(deviceId: string): Promise<Challenge> {
    const device = await this.#registry.requireDevice(deviceId);
    if (device.trust === "REVOKED" || device.revokedAt !== null) {
      throw new DeviceAuthenticationError(deviceId, "appareil révoqué");
    }

    const now = this.#now();
    const challenge: Challenge = {
      deviceId,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.#challengeTtlMs),
    };

    this.#challenges.set(challenge.nonce, challenge);
    this.#pruneExpired(now);
    return challenge;
  }

  /**
   * Vérifie la signature et ouvre une session.
   *
   * Les capacités négociées sont **bornées par celles de l'appareil** : un
   * worker qui prétendrait à une capacité non enregistrée n'obtient que
   * l'intersection. Il ne peut pas s'accorder de pouvoirs en se connectant.
   */
  async authenticate(input: AuthenticateInput, credentialMaterial: string): Promise<IssuedSession> {
    const now = this.#now();
    const device = await this.#registry.requireDevice(input.deviceId);

    if (device.trust === "REVOKED" || device.revokedAt !== null) {
      throw new DeviceAuthenticationError(input.deviceId, "appareil révoqué");
    }
    if (device.trust !== "TRUSTED") {
      throw new DeviceAuthenticationError(input.deviceId, "appareil pas encore approuvé");
    }

    const challenge = this.#challenges.get(input.nonce);
    if (challenge === undefined) {
      throw new ReplayRejectedError({
        message: `Nonce inconnu ou déjà consommé pour ${input.deviceId}`,
        context: { deviceId: input.deviceId },
      });
    }
    // Consommé quoi qu'il arrive : un nonce ne sert qu'une fois, même si la
    // signature est fausse. Sinon un attaquant pourrait le forcer.
    this.#challenges.delete(input.nonce);

    if (challenge.deviceId !== input.deviceId) {
      throw new ReplayRejectedError({
        message: "Nonce émis pour un autre appareil",
        context: { deviceId: input.deviceId },
      });
    }
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw new ReplayRejectedError({
        message: "Challenge expiré",
        context: { deviceId: input.deviceId },
      });
    }

    if (!this.#verify(credentialMaterial, input.nonce, input.signature)) {
      throw new DeviceAuthenticationError(input.deviceId, "signature invalide");
    }

    const declared = new Set(device.capabilities.filter((c) => c.enabled).map((c) => c.name));
    const negotiated =
      input.capabilities === undefined
        ? [...declared]
        : input.capabilities.filter((name) => declared.has(name));

    const token = randomBytes(32).toString("base64url");
    const session: DeviceSession = {
      id: this.#newId(),
      deviceId: device.id,
      userId: device.userId,
      tokenHash: hashToken(token),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      lastHeartbeatAt: now,
      rotatedFromId: null,
      revokedAt: null,
      capabilities: negotiated.sort(),
      remoteAddress: input.remoteAddress ?? null,
    };

    await this.#store.save(session);
    await this.#registry.setAuthenticated(device.id, true);
    await this.#registry.updateHeartbeat(device.id);

    return { session, token };
  }

  /**
   * Résout un jeton en session active.
   *
   * Retourne `undefined` plutôt que de lever : un jeton périmé est un cas
   * ordinaire, pas un incident. L'appelant renvoie 401 et l'appareil se
   * réauthentifie.
   */
  async resolve(token: string): Promise<DeviceSession | undefined> {
    const session = await this.#store.findByTokenHash(hashToken(token));
    if (session === undefined) return undefined;
    if (!isSessionActive(session, this.#now())) return undefined;

    const device = await this.#registry.getDevice(session.deviceId);
    // Une révocation prend effet immédiatement, même sur une session ouverte.
    if (device?.trust !== "TRUSTED" || device.revokedAt !== null) {
      return undefined;
    }
    return session;
  }

  /**
   * Rotation du jeton.
   *
   * L'ancienne session est révoquée dans le même mouvement : à aucun moment deux
   * jetons ne sont valides pour le même appareil.
   */
  async rotate(currentToken: string): Promise<IssuedSession> {
    const current = await this.resolve(currentToken);
    if (current === undefined) {
      throw new DeviceAuthenticationError("inconnu", "jeton de session invalide ou expiré");
    }

    const now = this.#now();
    const token = randomBytes(32).toString("base64url");
    const rotated: DeviceSession = {
      ...current,
      id: this.#newId(),
      tokenHash: hashToken(token),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      lastHeartbeatAt: now,
      rotatedFromId: current.id,
    };

    await this.#store.save({ ...current, revokedAt: now });
    await this.#store.save(rotated);
    return { session: rotated, token };
  }

  async heartbeat(token: string): Promise<DeviceSession | undefined> {
    const session = await this.resolve(token);
    if (session === undefined) return undefined;

    const updated: DeviceSession = { ...session, lastHeartbeatAt: this.#now() };
    await this.#store.save(updated);
    await this.#registry.updateHeartbeat(session.deviceId);
    return updated;
  }

  /** Ferme une session. L'appareil repasse hors ligne. */
  async revokeSession(sessionId: string): Promise<void> {
    const session = await this.#store.get(sessionId);
    if (session === undefined) return;

    await this.#store.save({ ...session, revokedAt: this.#now() });
    await this.#registry.setAuthenticated(session.deviceId, false);
  }

  /** Ferme toutes les sessions d'un appareil — utilisé à la révocation. */
  async revokeAllForDevice(deviceId: string): Promise<number> {
    const sessions = await this.#store.listByDevice(deviceId);
    const now = this.#now();
    let revoked = 0;

    for (const session of sessions) {
      if (session.revokedAt !== null) continue;
      await this.#store.save({ ...session, revokedAt: now });
      revoked += 1;
    }

    await this.#registry.setAuthenticated(deviceId, false);
    return revoked;
  }

  /**
   * Protection contre le rejeu d'une requête signée.
   *
   * Deux conditions : l'horodatage tient dans la fenêtre tolérée, et le
   * `requestId` n'a jamais été vu. La fenêtre borne aussi la mémoire — au-delà,
   * un identifiant ne peut plus être rejoué de toute façon.
   */
  assertNotReplayed(requestId: string, timestamp: Date): void {
    const now = this.#now().getTime();
    const drift = Math.abs(now - timestamp.getTime());

    if (drift > this.#clockSkewMs) {
      throw new ReplayRejectedError({
        message: `Horodatage hors fenêtre (${String(Math.round(drift / 1000))} s d'écart)`,
        context: { requestId },
      });
    }

    if (this.#usedNonces.has(requestId)) {
      throw new ReplayRejectedError({
        message: "Identifiant de requête déjà utilisé",
        context: { requestId },
      });
    }

    this.#usedNonces.set(requestId, now);
    this.#pruneExpired(this.#now());
  }

  /** Comparaison de jetons en temps constant. */
  static tokensMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  #pruneExpired(now: Date): void {
    const cutoff = now.getTime() - this.#clockSkewMs * 2;
    for (const [requestId, seenAt] of this.#usedNonces) {
      if (seenAt < cutoff) this.#usedNonces.delete(requestId);
    }
    for (const [nonce, challenge] of this.#challenges) {
      if (challenge.expiresAt.getTime() <= now.getTime()) this.#challenges.delete(nonce);
    }
  }
}
