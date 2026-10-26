import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { OsintInvestigation } from "./index.js";

export const archivedEvidenceSchema = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  url: z.string().url(),
  title: z.string().min(1),
  excerpt: z.string().max(4_000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.string().datetime(),
  reliability: z.enum(["primary", "corroborated", "unverified"]),
});
export type ArchivedEvidence = z.infer<typeof archivedEvidenceSchema>;

export interface OsintEntity {
  id: string;
  type: string;
  label: string;
  confidence: number;
}
export interface OsintRelation {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  confidence: number;
  evidenceIds: string[];
}
export interface OsintWatch {
  id: string;
  query: string;
  intervalMinutes: number;
  lastFingerprint?: string;
  enabled: boolean;
}
export interface OsintAlert {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  acknowledged: boolean;
}
export interface OsintCaseRecord {
  id: string;
  ownerId: string;
  investigation: OsintInvestigation;
  status: "open" | "monitoring" | "closed";
  evidence: ArchivedEvidence[];
  entities: OsintEntity[];
  relations: OsintRelation[];
  watches: OsintWatch[];
  alerts: OsintAlert[];
  createdAt: string;
  updatedAt: string;
}

export class InMemoryOsintCaseStore {
  readonly #cases = new Map<string, OsintCaseRecord>();

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
    input: Omit<ArchivedEvidence, "id" | "caseId" | "contentHash" | "observedAt"> & {
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
    const entity = { ...input, id: randomUUID() };
    record.entities.push(entity);
    return structuredClone(entity);
  }
  addRelation(ownerId: string, caseId: string, input: Omit<OsintRelation, "id">): OsintRelation {
    const record = this.#owned(ownerId, caseId);
    if (
      !record.entities.some((e) => e.id === input.sourceId) ||
      !record.entities.some((e) => e.id === input.targetId)
    )
      throw new Error("Relation endpoints must belong to the case.");
    const relation = { ...input, id: randomUUID() };
    record.relations.push(relation);
    return structuredClone(relation);
  }
  addWatch(ownerId: string, caseId: string, query: string, intervalMinutes: number): OsintWatch {
    const record = this.#owned(ownerId, caseId);
    const watch = { id: randomUUID(), query, intervalMinutes, enabled: true };
    record.watches.push(watch);
    record.status = "monitoring";
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
    return structuredClone(alert);
  }
  #owned(ownerId: string, id: string): OsintCaseRecord {
    const record = this.#cases.get(id);
    if (record?.ownerId !== ownerId) throw new Error("OSINT case not found.");
    return record;
  }
}
