import type { PrismaClient } from "@nexus/database";
import {
  osintCaseRecordSchema,
  osintMissionSchema,
  type OsintCaseRecord,
  type OsintMission,
} from "@nexus/osint";

export interface OsintPersistence {
  loadCases(): Promise<OsintCaseRecord[]>;
  saveCase(record: OsintCaseRecord): Promise<void>;
  loadMissions(): Promise<OsintMission[]>;
  saveMission(mission: OsintMission): Promise<void>;
  importCases(records: OsintCaseRecord[]): Promise<void>;
}

export class PrismaOsintStore implements OsintPersistence {
  readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }
  async loadCases() {
    return (await this.prisma.osintCaseSnapshot.findMany()).map((row) =>
      osintCaseRecordSchema.parse(row.payload),
    );
  }
  async saveCase(record: OsintCaseRecord) {
    await this.prisma.osintCaseSnapshot.upsert({
      where: { id: record.id },
      create: { id: record.id, ownerId: record.ownerId, payload: record as never },
      update: { payload: record as never },
    });
  }
  async loadMissions() {
    return (await this.prisma.osintMissionSnapshot.findMany()).map((row) =>
      osintMissionSchema.parse(row.payload),
    );
  }
  async saveMission(mission: OsintMission) {
    await this.prisma.osintMissionSnapshot.upsert({
      where: { id: mission.id },
      create: {
        id: mission.id,
        ownerId: mission.ownerId,
        caseId: mission.caseId,
        status: mission.status,
        payload: mission as never,
      },
      update: { status: mission.status, payload: mission as never },
    });
  }
  async importCases(records: OsintCaseRecord[]) {
    // Transactional marker makes the legacy JSON import one-shot, including an empty file.
    await this.prisma.$transaction(async (tx) => {
      if (await tx.osintImport.findUnique({ where: { id: "osint-cases.json" } })) return;
      for (const record of records) {
        const parsed = osintCaseRecordSchema.parse(record);
        await tx.osintCaseSnapshot.upsert({
          where: { id: parsed.id },
          create: { id: parsed.id, ownerId: parsed.ownerId, payload: parsed as never },
          update: {},
        });
      }
      await tx.osintImport.create({ data: { id: "osint-cases.json" } });
    });
  }
}
