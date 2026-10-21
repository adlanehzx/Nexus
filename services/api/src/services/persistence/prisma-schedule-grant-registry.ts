import type { PrismaClient } from "@nexus/database";
import type { ScheduleGrantRecord, ScheduleGrantRegistry } from "../schedule-grants.js";

export class PrismaScheduleGrantRegistry implements ScheduleGrantRegistry {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async record(record: ScheduleGrantRecord): Promise<void> {
    await this.#prisma.scheduleGrant.create({
      data: {
        id: record.id,
        tokenHash: record.tokenHash,
        userId: record.userId,
        missionExternalKey: record.missionExternalKey,
        scheduleId: record.scheduleId,
        status: record.status,
        createdAt: record.createdAt,
        revokedAt: record.revokedAt,
      },
    });
  }

  async findByTokenHash(tokenHash: string): Promise<ScheduleGrantRecord | undefined> {
    const row = await this.#prisma.scheduleGrant.findUnique({ where: { tokenHash } });
    return row === null ? undefined : present(row);
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.#prisma.scheduleGrant.updateMany({
      where: { id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: at },
    });
  }
}

function present(row: {
  id: string;
  tokenHash: string;
  userId: string;
  missionExternalKey: string;
  scheduleId: string;
  status: string;
  createdAt: Date;
  revokedAt: Date | null;
}): ScheduleGrantRecord {
  return {
    ...row,
    status: row.status as ScheduleGrantRecord["status"],
  };
}
