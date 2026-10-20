import { AuthorizationError } from "@nexus/shared";
import type { MissionGrantClaims } from "@nexus/auth";

/**
 * Cycle de vie d'une assertion de mission.
 *
 * `COMPLETED` et `REVOKED` sont tous deux des retraits, et les distinguer n'est
 * pas cosmétique : le premier est le chemin normal — la mission est finie — et
 * le second un chemin d'incident. Les confondre rendrait impossible de répondre
 * à « quelles assertions a-t-on dû retirer en urgence ».
 */
export type MissionGrantState = "ACTIVE" | "COMPLETED" | "REVOKED";

export interface MissionGrantRecord {
  /** Le `jti` de l'assertion. */
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
   * Retire toutes les assertions encore actives d'une mission.
   *
   * L'opération porte sur la mission et non sur une assertion, parce que la
   * rotation en laisse plusieurs valides en même temps : retirer seulement
   * celle qu'on a sous la main laisserait les autres ouvertes.
   *
   * @returns le nombre d'assertions retirées.
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

/** Ce que le service a besoin de savoir faire du `TokenService`. */
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
   * Marge avant expiration à partir de laquelle une assertion est renouvelée.
   *
   * Large par rapport à la durée de vie — huit heures sur vingt-quatre — parce
   * que la rotation est opportuniste : elle se produit quand le moteur passe,
   * et il peut ne pas passer pendant des heures si la mission attend une
   * décision humaine. Une marge étroite laisserait une mission longue mourir
   * entre deux sondages.
   */
  renewWithinMs?: number;
  now?: () => Date;
}

/**
 * Émission, vérification, rotation et retrait des assertions de mission.
 *
 * Réunir les quatre dans un même service est délibéré : ce sont quatre faces
 * d'une seule invariante — une assertion n'ouvre que si elle est signée, connue
 * du registre, active et non expirée. Les disperser laisserait inévitablement
 * un appelant signer sans enregistrer, et une assertion non enregistrée est
 * précisément celle qu'on ne peut pas retirer.
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

  /** Émet une assertion **et** l'inscrit au registre, dans cet ordre. */
  async issue(input: {
    userId: string;
    service: string;
    missionExternalKey: string;
  }): Promise<IssuedMissionGrant> {
    const signed = this.#signer.issueMissionGrant(input);
    // Inscrit avant d'être rendu : une assertion qui circulerait sans être au
    // registre serait refusée à la première utilisation, ce qui est déroutant,
    // ou — bien pire si l'on inversait la règle — irrévocable.
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
   * Vérifie qu'une assertion déjà authentifiée est toujours exploitable.
   *
   * La signature a été vérifiée en amont ; ce qui est contrôlé ici est l'état.
   * Les messages d'erreur ne distinguent pas « inconnue » de « retirée » côté
   * utilisateur : la différence n'aiderait qu'à sonder le registre.
   */
  async assertUsable(claims: MissionGrantClaims): Promise<MissionGrantRecord> {
    const grant = await this.#registry.find(claims.jti);
    if (grant === undefined) {
      throw new AuthorizationError({
        message: `Assertion de mission absente du registre : ${claims.jti}`,
        userMessage: "Accès refusé.",
        context: { grantId: claims.jti },
      });
    }
    if (grant.status !== "ACTIVE") {
      throw new AuthorizationError({
        message: `Assertion de mission retirée (${grant.status}) : ${claims.jti}`,
        userMessage: "Accès refusé.",
        context: { grantId: claims.jti, status: grant.status },
      });
    }
    // Le registre reste autoritaire sur l'expiration, en plus de la signature.
    // Les deux peuvent diverger si l'horloge d'un processus dérive, et la
    // décision la plus restrictive est la bonne.
    if (grant.expiresAt.getTime() <= this.#now().getTime()) {
      throw new AuthorizationError({
        message: `Assertion de mission expirée : ${claims.jti}`,
        userMessage: "Accès refusé.",
        context: { grantId: claims.jti },
      });
    }
    return grant;
  }

  /**
   * Renouvelle une assertion qui approche de son terme, ou ne fait rien.
   *
   * L'ancienne n'est **pas** retirée : elle expirera d'elle-même. La retirer
   * ici casserait toute requête déjà en vol avec, et le gain serait nul — ce
   * qu'on veut éviter est une mission qui meurt faute d'assertion valide, pas
   * une assertion qui vit ses dernières heures.
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
   * Renouvelle par identifiant, pour les routes qui n'ont que le `jti`.
   *
   * Relit le registre plutôt que de faire transiter l'enregistrement depuis la
   * garde : une lecture de plus par requête sur cette seule surface, contre un
   * type de principal qui devrait porter une date d'expiration dont aucune
   * autre surface n'a l'usage.
   */
  async renewById(grantId: string): Promise<IssuedMissionGrant | undefined> {
    const grant = await this.#registry.find(grantId);
    if (grant?.status !== "ACTIVE") return undefined;
    return this.renewIfNeeded(grant);
  }

  /** Retire les assertions d'une mission terminée. */
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
