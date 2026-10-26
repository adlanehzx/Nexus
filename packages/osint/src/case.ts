import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { OsintInvestigation } from "./policy.js";

export const archivedEvidenceSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  url: z.string().url(),
  title: z.string().min(1),
  excerpt: z.string().max(4_000),
  contentSnapshot: z.string().max(1_000_000).default(""),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.string().datetime(),
  reliability: z.enum(["primary", "corroborated", "unverified"]),
});
export type ArchivedEvidence = z.infer<typeof archivedEvidenceSchema>;

export const osintEntitySchema = z.object({
  id: z.string().uuid(),
  type: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
});
export type OsintEntity = z.infer<typeof osintEntitySchema>;

export const osintRelationSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  label: z.string().trim().min(1).max(160),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().uuid()).max(100),
});
export type OsintRelation = z.infer<typeof osintRelationSchema>;

export const osintWatchSchema = z.object({
  id: z.string().uuid(),
  query: z.string().trim().min(2).max(1_000),
  intervalMinutes: z.number().int().min(15).max(525_600),
  lastFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  lastCheckedAt: z.string().datetime().optional(),
  enabled: z.boolean(),
});
export type OsintWatch = z.infer<typeof osintWatchSchema>;

export const osintAlertSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(500),
  detail: z.string().max(4_000),
  createdAt: z.string().datetime(),
  acknowledged: z.boolean(),
});
export type OsintAlert = z.infer<typeof osintAlertSchema>;

export const osintCaseRecordSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().min(1),
  investigation: z.object({
    title: z.string().trim().min(3).max(120),
    kind: z.enum(["professional_person", "organization", "technical_asset", "claim_verification"]),
    target: z.string().trim().min(2).max(500),
    objective: z.string().trim().min(10).max(2_000),
    maxSources: z.number().int().min(3).max(40),
    lawfulPurposeConfirmed: z.literal(true),
  }),
  status: z.enum(["open", "monitoring", "closed"]),
  evidence: z.array(archivedEvidenceSchema),
  entities: z.array(osintEntitySchema),
  relations: z.array(osintRelationSchema),
  watches: z.array(osintWatchSchema),
  alerts: z.array(osintAlertSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OsintCaseRecord = z.infer<typeof osintCaseRecordSchema>;

export class InMemoryOsintCaseStore {
  readonly #cases = new Map<string, OsintCaseRecord>();

  constructor(records: OsintCaseRecord[] = []) {
    for (const record of records) {
      const parsed = osintCaseRecordSchema.parse(record);
      this.#cases.set(parsed.id, structuredClone(parsed));
    }
  }

  snapshot(): OsintCaseRecord[] {
    return [...this.#cases.values()].map((item) => structuredClone(item));
  }

  create(ownerId: string, investigation: OsintInvestigation, now = new Date()): OsintCaseRecord {
    const record: OsintCaseRecord = {
      id: randomUUID(),
      ownerId,
      investigation,
      status: "open",
      evidence: [],
      entities: [],
      relations: [],
      watches: [],
      alerts: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.#cases.set(record.id, record);
    return structuredClone(record);
  }
  list(ownerId: string): OsintCaseRecord[] {
    return [...this.#cases.values()]
      .filter((item) => item.ownerId === ownerId)
      .map((item) => structuredClone(item));
  }
  get(ownerId: string, id: string): OsintCaseRecord | undefined {
    const value = this.#cases.get(id);
    return value?.ownerId === ownerId ? structuredClone(value) : undefined;
  }
  addEvidence(
    ownerId: string,
    caseId: string,
    input: Omit<
      ArchivedEvidence,
      "id" | "caseId" | "contentHash" | "contentSnapshot" | "observedAt"
    > & {
      content: string;
    },
    now = new Date(),
  ): ArchivedEvidence {
    const record = this.#owned(ownerId, caseId);
    const evidence = archivedEvidenceSchema.parse({
      ...input,
      id: randomUUID(),
      caseId,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      contentSnapshot: input.content,
      observedAt: now.toISOString(),
    });
    const duplicate = record.evidence.find((item) => item.contentHash === evidence.contentHash);
    if (duplicate !== undefined) return structuredClone(duplicate);
    record.evidence.push(evidence);
    record.updatedAt = now.toISOString();
    return structuredClone(evidence);
  }
  addEntity(ownerId: string, caseId: string, input: Omit<OsintEntity, "id">): OsintEntity {
    const record = this.#owned(ownerId, caseId);
    const entity = osintEntitySchema.parse({ ...input, id: randomUUID() });
    record.entities.push(entity);
    record.updatedAt = new Date().toISOString();
    return structuredClone(entity);
  }
  addRelation(ownerId: string, caseId: string, input: Omit<OsintRelation, "id">): OsintRelation {
    const record = this.#owned(ownerId, caseId);
    if (
      !record.entities.some((e) => e.id === input.sourceId) ||
      !record.entities.some((e) => e.id === input.targetId)
    )
      throw new Error("Relation endpoints must belong to the case.");
    const relation = osintRelationSchema.parse({ ...input, id: randomUUID() });
    record.relations.push(relation);
    record.updatedAt = new Date().toISOString();
    return structuredClone(relation);
  }
  addWatch(ownerId: string, caseId: string, query: string, intervalMinutes: number): OsintWatch {
    const record = this.#owned(ownerId, caseId);
    const watch = osintWatchSchema.parse({
      id: randomUUID(),
      query,
      intervalMinutes,
      enabled: true,
    });
    record.watches.push(watch);
    record.status = "monitoring";
    record.updatedAt = new Date().toISOString();
    return structuredClone(watch);
  }
  evaluateWatch(
    ownerId: string,
    caseId: string,
    watchId: string,
    content: string,
    now = new Date(),
  ): OsintAlert | undefined {
    const record = this.#owned(ownerId, caseId);
    const watch = record.watches.find((item) => item.id === watchId);
    if (watch?.enabled !== true) throw new Error("Watch not found.");
    const fingerprint = createHash("sha256").update(content).digest("hex");
    watch.lastCheckedAt = now.toISOString();
    record.updatedAt = now.toISOString();
    if (watch.lastFingerprint === undefined) {
      watch.lastFingerprint = fingerprint;
      return undefined;
    }
    if (watch.lastFingerprint === fingerprint) return undefined;
    watch.lastFingerprint = fingerprint;
    const alert = {
      id: randomUUID(),
      title: `Change detected: ${watch.query}`,
      detail: "Public-source content changed since the previous observation.",
      createdAt: now.toISOString(),
      acknowledged: false,
    };
    record.alerts.push(alert);
    record.updatedAt = now.toISOString();
    return structuredClone(alert);
  }

  acknowledgeAlert(ownerId: string, caseId: string, alertId: string): OsintAlert {
    const record = this.#owned(ownerId, caseId);
    const alert = record.alerts.find((item) => item.id === alertId);
    if (alert === undefined) throw new Error("Alert not found.");
    alert.acknowledged = true;
    record.updatedAt = new Date().toISOString();
    return structuredClone(alert);
  }
  #owned(ownerId: string, id: string): OsintCaseRecord {
    const record = this.#cases.get(id);
    if (record?.ownerId !== ownerId) throw new Error("OSINT case not found.");
    return record;
  }
}
