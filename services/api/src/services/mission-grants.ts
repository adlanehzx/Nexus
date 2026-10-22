import { AuthorizationError } from "@nexus/shared";
import type { MissionGrantClaims } from "@nexus/auth";

/**
 * Lifecycle of a mission grant assertion.
 *
 * `COMPLETED` and `REVOKED` are both forms of revocation, and distinguishing them
 * is not cosmetic: the first represents the normal path — the mission finished — while
 * the second is an incident mitigation path. Conflating them would make it impossible
 * to answer "which grants had to be revoked urgently".
 */
export type MissionGrantState = "ACTIVE" | "COMPLETED" | "REVOKED";

export interface MissionGrantRecord {
  /** The assertion `jti`. */
  grantId: string;
  missionExternalKey: string;
  userId: string;
  service: string;
  issuedAt: Date;
  expiresAt: Date;
  status: MissionGrantState;
  retiredAt: Date | null;
}

export interface MissionGrantRegistry {
  record(input: Omit<MissionGrantRecord, "status" | "retiredAt">): Promise<void>;
  find(grantId: string): Promise<MissionGrantRecord | undefined>;
  /**
   * Revokes all still-active assertions for a mission.
   *
   * The operation targets the mission rather than a single assertion, because
   * rotation leaves multiple grants valid simultaneously: revoking only the
   * current one on hand would leave others open.
   *
   * @returns number of revoked assertions.
   */
  retireMission(
    missionExternalKey: string,
    status: Exclude<MissionGrantState, "ACTIVE">,
    at: Date,
  ): Promise<number>;
  listByMission(missionExternalKey: string): Promise<MissionGrantRecord[]>;
}

export class InMemoryMissionGrantRegistry implements MissionGrantRegistry {
  readonly #grants = new Map<string, MissionGrantRecord>();

  record(input: Omit<MissionGrantRecord, "status" | "retiredAt">): Promise<void> {
    this.#grants.set(input.grantId, { ...input, status: "ACTIVE", retiredAt: null });
    return Promise.resolve();
  }

  find(grantId: string): Promise<MissionGrantRecord | undefined> {
    return Promise.resolve(this.#grants.get(grantId));
  }

  retireMission(
    missionExternalKey: string,
    status: Exclude<MissionGrantState, "ACTIVE">,
    at: Date,
  ): Promise<number> {
    let retired = 0;
    for (const [id, grant] of this.#grants) {
      if (grant.missionExternalKey !== missionExternalKey || grant.status !== "ACTIVE") continue;
      this.#grants.set(id, { ...grant, status, retiredAt: at });
      retired += 1;
    }
    return Promise.resolve(retired);
  }

  listByMission(missionExternalKey: string): Promise<MissionGrantRecord[]> {
    return Promise.resolve(
      [...this.#grants.values()].filter((grant) => grant.missionExternalKey === missionExternalKey),
    );
  }
}

/** Capabilities required by this service from `TokenService`. */
export interface MissionGrantSigner {
  issueMissionGrant(input: { userId: string; service: string; missionExternalKey: string }): {
    token: string;
    expiresAt: Date;
    grantId: string;
  };
}

export interface IssuedMissionGrant {
  token: string;
  grantId: string;
  expiresAt: Date;
}

export interface MissionGrantServiceOptions {
  signer: MissionGrantSigner;
  registry: MissionGrantRegistry;
  /**
   * Expiration margin threshold triggering grant renewal.
   *
   * Broad relative to overall lifespan — eight hours out of twenty-four — because
   * rotation is opportunistic: it occurs when the engine interacts, which
   * may pause for hours while awaiting human approval. A narrow margin
   * would let long-running missions die between polls.
   */
  renewWithinMs?: number;
  now?: () => Date;
}

/**
 * Issuance, verification, rotation, and revocation of mission grant assertions.
 *
 * Consolidating all four in one service is intentional: they are four facets
 * of a single invariant — a grant only authenticates if signed, recognized by
 * the registry, active, and unexpired. Dispersing them would inevitably allow
 * a caller to sign without registering, and an unregistered assertion is
 * precisely the kind that cannot be revoked.
 */
export class MissionGrantService {
  readonly #signer: MissionGrantSigner;
  readonly #registry: MissionGrantRegistry;
  readonly #renewWithinMs: number;
  readonly #now: () => Date;

  constructor(options: MissionGrantServiceOptions) {
    this.#signer = options.signer;
    this.#registry = options.registry;
    this.#renewWithinMs = options.renewWithinMs ?? 8 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  /** Issues an assertion **and** records it in the registry, in that order. */
  async issue(input: {
    userId: string;
    service: string;
    missionExternalKey: string;
  }): Promise<IssuedMissionGrant> {
    const signed = this.#signer.issueMissionGrant(input);
    // Registered prior to returning: an assertion circulating without registry
    // presence would be rejected upon first use, creating confusion, or
    // — far worse if the rule were reversed — become irrevocable.
    await this.#registry.record({
      grantId: signed.grantId,
      missionExternalKey: input.missionExternalKey,
      userId: input.userId,
      service: input.service,
      issuedAt: this.#now(),
      expiresAt: signed.expiresAt,
    });
    return { token: signed.token, grantId: signed.grantId, expiresAt: signed.expiresAt };
  }

  /**
   * Verifies that an already-authenticated assertion remains usable.
   *
   * The cryptographic signature was verified upstream; state is checked here.
   * Error messages do not distinguish between "unknown" and "revoked" on the
   * user side: the difference would only aid in probing registry entries.
   */
  async assertUsable(claims: MissionGrantClaims): Promise<MissionGrantRecord> {
    const grant = await this.#registry.find(claims.jti);
    if (grant === undefined) {
      throw new AuthorizationError({
        message: `Mission grant missing from registry: ${claims.jti}`,
        userMessage: "Access denied.",
        context: { grantId: claims.jti },
      });
    }
    if (grant.status !== "ACTIVE") {
      throw new AuthorizationError({
        message: `Mission grant revoked (${grant.status}): ${claims.jti}`,
        userMessage: "Access denied.",
        context: { grantId: claims.jti, status: grant.status },
      });
    }
    // The registry remains authoritative on expiration, alongside the signature.
    // The two can diverge if process clocks drift, and the more restrictive
    // decision applies.
    if (grant.expiresAt.getTime() <= this.#now().getTime()) {
      throw new AuthorizationError({
        message: `Mission grant expired: ${claims.jti}`,
        userMessage: "Access denied.",
        context: { grantId: claims.jti },
      });
    }
    return grant;
  }

  /**
   * Renews an assertion nearing expiration, or does nothing.
   *
   * The old assertion is **not** revoked: it will expire on its own. Revoking
   * it here would break in-flight requests using it, with no security gain — our
   * goal is preventing a mission from failing due to an expired grant, not
   * truncating an assertion during its final hours.
   */
  async renewIfNeeded(grant: MissionGrantRecord): Promise<IssuedMissionGrant | undefined> {
    const remaining = grant.expiresAt.getTime() - this.#now().getTime();
    if (remaining > this.#renewWithinMs) return undefined;

    return this.issue({
      userId: grant.userId,
      service: grant.service,
      missionExternalKey: grant.missionExternalKey,
    });
  }

  /**
   * Renews by identifier, for routes that only have `jti`.
   *
   * Re-reads registry rather than threading the record through the auth
   * guard: one additional read per request on this surface only, avoiding
   * polluting the principal type with an expiration timestamp needed nowhere
   * else.
   */
  async renewById(grantId: string): Promise<IssuedMissionGrant | undefined> {
    const grant = await this.#registry.find(grantId);
    if (grant?.status !== "ACTIVE") return undefined;
    return this.renewIfNeeded(grant);
  }

  /** Revokes assertions of a completed mission. */
  retire(
    missionExternalKey: string,
    status: Exclude<MissionGrantState, "ACTIVE"> = "COMPLETED",
  ): Promise<number> {
    return this.#registry.retireMission(missionExternalKey, status, this.#now());
  }

  listByMission(missionExternalKey: string): Promise<MissionGrantRecord[]> {
    return this.#registry.listByMission(missionExternalKey);
  }
}
