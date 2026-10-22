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
   * Revokes in a single write the still-active assertions of a mission.
   *
   * The filter on `ACTIVE` makes the operation idempotent: a second
   * call does not rewrite anything and does not shift the revocation timestamp. The engine can
   * therefore retry revocation safely if its first attempt
   * failed on the network.
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
