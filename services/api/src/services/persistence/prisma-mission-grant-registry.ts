import type { PrismaClient } from "@nexus/database";
import type {
  MissionGrantRecord,
  MissionGrantRegistry,
  MissionGrantState,
} from "../mission-grants.js";

export class PrismaMissionGrantRegistry implements MissionGrantRegistry {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async record(input: Omit<MissionGrantRecord, "status" | "retiredAt">): Promise<void> {
    await this.#prisma.missionGrant.create({
      data: {
        id: input.grantId,
        missionExternalKey: input.missionExternalKey,
        userId: input.userId,
        service: input.service,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      },
    });
  }

  async find(grantId: string): Promise<MissionGrantRecord | undefined> {
    const row = await this.#prisma.missionGrant.findUnique({ where: { id: grantId } });
    return row === null ? undefined : present(row);
  }

  /**
   * Retire en une seule écriture les assertions encore actives d'une mission.
   *
   * Le filtre sur `ACTIVE` est ce qui rend l'opération idempotente : un second
   * appel ne réécrit rien et ne déplace pas la date de retrait. Le moteur peut
   * donc redemander le retrait sans précaution si sa première tentative a
   * échoué sur le réseau.
   */
  async retireMission(
    missionExternalKey: string,
    status: Exclude<MissionGrantState, "ACTIVE">,
    at: Date,
  ): Promise<number> {
    const result = await this.#prisma.missionGrant.updateMany({
      where: { missionExternalKey, status: "ACTIVE" },
      data: { status, retiredAt: at },
    });
    return result.count;
  }

  async listByMission(missionExternalKey: string): Promise<MissionGrantRecord[]> {
    const rows = await this.#prisma.missionGrant.findMany({
      where: { missionExternalKey },
      orderBy: { issuedAt: "asc" },
    });
    return rows.map(present);
  }
}

function present(row: {
  id: string;
  missionExternalKey: string;
  userId: string;
  service: string;
  issuedAt: Date;
  expiresAt: Date;
  status: string;
  retiredAt: Date | null;
}): MissionGrantRecord {
  return {
    grantId: row.id,
    missionExternalKey: row.missionExternalKey,
    userId: row.userId,
    service: row.service,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    status: row.status as MissionGrantState,
    retiredAt: row.retiredAt,
  };
}
