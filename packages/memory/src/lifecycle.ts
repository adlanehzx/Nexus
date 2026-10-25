import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { MemoryProvider, MemoryStoreInput } from "./provider.js";
import type { MemoryRecord } from "./types.js";
import type { MemoryService, RememberInput } from "./service.js";

export interface ConsolidationProposal {
  id: string;
  userId: string;
  createdAt: Date;
  status: "PENDING_REVIEW" | "REJECTED" | "APPLIED" | "ROLLED_BACK";
  canonicalId: string;
  duplicateIds: string[];
  snapshots: MemoryStoreInput[];
}

export interface MemoryImportJob {
  id: string;
  userId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
  processed: number;
  stored: number;
  duplicates: number;
  rejected: number;
  total: number;
}

export interface RetentionPolicy {
  projectId: string | null;
  maxAgeDays: number;
  minimumImportance: number;
}

export interface MemoryLifecycleStateStore {
  saveProposal(proposal: ConsolidationProposal): Promise<void>;
  proposal(id: string): Promise<ConsolidationProposal | undefined>;
  saveImport(job: MemoryImportJob): Promise<void>;
  importJob(id: string): Promise<MemoryImportJob | undefined>;
  setSharing(userId: string, memoryId: string, agentIds: readonly string[]): Promise<void>;
  sharing(userId: string, memoryId: string): Promise<readonly string[]>;
  setRetention(userId: string, policy: RetentionPolicy): Promise<void>;
  retention(userId: string): Promise<readonly RetentionPolicy[]>;
}

export class InMemoryMemoryLifecycleStateStore implements MemoryLifecycleStateStore {
  readonly #proposals = new Map<string, ConsolidationProposal>();
  readonly #imports = new Map<string, MemoryImportJob>();
  readonly #sharing = new Map<string, readonly string[]>();
  readonly #retention = new Map<string, RetentionPolicy[]>();

  saveProposal(proposal: ConsolidationProposal): Promise<void> {
    this.#proposals.set(proposal.id, structuredClone(proposal));
    return Promise.resolve();
  }
  proposal(id: string): Promise<ConsolidationProposal | undefined> {
    const value = this.#proposals.get(id);
    return Promise.resolve(value === undefined ? undefined : structuredClone(value));
  }
  saveImport(job: MemoryImportJob): Promise<void> {
    this.#imports.set(job.id, { ...job });
    return Promise.resolve();
  }
  importJob(id: string): Promise<MemoryImportJob | undefined> {
    const value = this.#imports.get(id);
    return Promise.resolve(value === undefined ? undefined : { ...value });
  }
  setSharing(userId: string, memoryId: string, agentIds: readonly string[]): Promise<void> {
    this.#sharing.set(`${userId}:${memoryId}`, [...new Set(agentIds)]);
    return Promise.resolve();
  }
  sharing(userId: string, memoryId: string): Promise<readonly string[]> {
    return Promise.resolve(this.#sharing.get(`${userId}:${memoryId}`) ?? []);
  }
  setRetention(userId: string, policy: RetentionPolicy): Promise<void> {
    const policies = this.#retention.get(userId) ?? [];
    const retained = policies.filter((item) => item.projectId !== policy.projectId);
    this.#retention.set(userId, [...retained, policy]);
    return Promise.resolve();
  }
  retention(userId: string): Promise<readonly RetentionPolicy[]> {
    return Promise.resolve(this.#retention.get(userId) ?? []);
  }
}

interface SerializedLifecycleState {
  proposals: ConsolidationProposal[];
  imports: MemoryImportJob[];
  sharing: { userId: string; memoryId: string; agentIds: string[] }[];
  retention: { userId: string; policies: RetentionPolicy[] }[];
}

/** Crash-safe local persistence for lifecycle workflows in personal installations. */
export class FileMemoryLifecycleStateStore implements MemoryLifecycleStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async saveProposal(proposal: ConsolidationProposal): Promise<void> {
    const state = await this.#read();
    state.proposals = [...state.proposals.filter((item) => item.id !== proposal.id), proposal];
    await this.#write(state);
  }

  async proposal(id: string): Promise<ConsolidationProposal | undefined> {
    return (await this.#read()).proposals.find((item) => item.id === id);
  }

  async saveImport(job: MemoryImportJob): Promise<void> {
    const state = await this.#read();
    state.imports = [...state.imports.filter((item) => item.id !== job.id), job];
    await this.#write(state);
  }

  async importJob(id: string): Promise<MemoryImportJob | undefined> {
    return (await this.#read()).imports.find((item) => item.id === id);
  }

  async setSharing(userId: string, memoryId: string, agentIds: readonly string[]): Promise<void> {
    const state = await this.#read();
    state.sharing = [
      ...state.sharing.filter((item) => item.userId !== userId || item.memoryId !== memoryId),
      { userId, memoryId, agentIds: [...new Set(agentIds)] },
    ];
    await this.#write(state);
  }

  async sharing(userId: string, memoryId: string): Promise<readonly string[]> {
    return (
      (await this.#read()).sharing.find(
        (item) => item.userId === userId && item.memoryId === memoryId,
      )?.agentIds ?? []
    );
  }

  async setRetention(userId: string, policy: RetentionPolicy): Promise<void> {
    const state = await this.#read();
    const existing = state.retention.find((item) => item.userId === userId)?.policies ?? [];
    const policies = [...existing.filter((item) => item.projectId !== policy.projectId), policy];
    state.retention = [
      ...state.retention.filter((item) => item.userId !== userId),
      { userId, policies },
    ];
    await this.#write(state);
  }

  async retention(userId: string): Promise<readonly RetentionPolicy[]> {
    return (await this.#read()).retention.find((item) => item.userId === userId)?.policies ?? [];
  }

  async #read(): Promise<SerializedLifecycleState> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as SerializedLifecycleState;
      return {
        ...parsed,
        proposals: parsed.proposals.map((item) => ({
          ...item,
          createdAt: new Date(item.createdAt),
          snapshots: item.snapshots.map((snapshot) => ({
            ...snapshot,
            ...(snapshot.extractedAt === undefined
              ? {}
              : { extractedAt: new Date(snapshot.extractedAt) }),
          })),
        })),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { proposals: [], imports: [], sharing: [], retention: [] };
    }
  }

  async #write(state: SerializedLifecycleState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#path);
  }
}

export interface TemporalContradiction {
  factKey: string;
  current: MemoryRecord;
  conflicting: MemoryRecord[];
}

export interface KnowledgeGraphProjection {
  nodes: { id: string; content: string; projectId: string | null; provenance: string | null }[];
  edges: { from: string; to: string; type: "SUPERSEDES" | "CONTRADICTS" }[];
}

export class AdvancedMemoryLifecycle {
  readonly #provider: MemoryProvider;
  readonly #service: MemoryService;
  readonly #state: MemoryLifecycleStateStore;
  readonly #now: () => Date;

  constructor(options: {
    provider: MemoryProvider;
    service: MemoryService;
    state?: MemoryLifecycleStateStore;
    now?: () => Date;
  }) {
    this.#provider = options.provider;
    this.#service = options.service;
    this.#state = options.state ?? new InMemoryMemoryLifecycleStateStore();
    this.#now = options.now ?? (() => new Date());
  }

  async hierarchy(
    userId: string,
    projectId?: string,
  ): Promise<{
    archival: MemoryRecord[];
    preferences: MemoryRecord[];
  }> {
    const records = (
      await this.#provider.search({ userId, query: "", limit: 100_000, includeSuperseded: false })
    )
      .map((hit) => hit.record)
      .filter((record) => projectId === undefined || record.tags.includes(projectTag(projectId)));
    return {
      archival: records.filter((record) => record.layer === "LONG_TERM"),
      preferences: records.filter((record) => record.layer === "PREFERENCE"),
    };
  }

  async proposeConsolidation(userId: string): Promise<ConsolidationProposal[]> {
    const records = (
      await this.#provider.search({ userId, query: "", limit: 100_000, includeSuperseded: false })
    ).map((hit) => hit.record);
    const groups = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const key = `${record.layer}:${record.kind}:${record.contentHash}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const proposals: ConsolidationProposal[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [canonical, ...duplicates] = [...group].sort(
        (left, right) =>
          right.importance - left.importance ||
          left.validFrom.getTime() - right.validFrom.getTime(),
      );
      if (canonical === undefined) continue;
      const proposal: ConsolidationProposal = {
        id: randomUUID(),
        userId,
        createdAt: this.#now(),
        status: "PENDING_REVIEW",
        canonicalId: canonical.id,
        duplicateIds: duplicates.map((record) => record.id),
        snapshots: duplicates.map(toStoreInput),
      };
      await this.#state.saveProposal(proposal);
      proposals.push(proposal);
    }
    return proposals;
  }

  async reviewConsolidation(
    userId: string,
    proposalId: string,
    decision: "APPROVE" | "REJECT",
  ): Promise<ConsolidationProposal> {
    const proposal = await this.#state.proposal(proposalId);
    if (proposal?.userId !== userId || proposal?.status !== "PENDING_REVIEW") {
      throw new Error("Consolidation proposal is unavailable");
    }
    if (decision === "APPROVE") {
      for (const id of proposal.duplicateIds) await this.#provider.delete({ userId, id });
      proposal.status = "APPLIED";
    } else {
      proposal.status = "REJECTED";
    }
    await this.#state.saveProposal(proposal);
    return proposal;
  }

  async rollbackConsolidation(userId: string, proposalId: string): Promise<ConsolidationProposal> {
    const proposal = await this.#state.proposal(proposalId);
    if (proposal?.userId !== userId || proposal?.status !== "APPLIED") {
      throw new Error("Applied consolidation proposal is unavailable");
    }
    for (const snapshot of proposal.snapshots) await this.#provider.store(snapshot);
    proposal.status = "ROLLED_BACK";
    await this.#state.saveProposal(proposal);
    return proposal;
  }

  detectContradictions(records: readonly MemoryRecord[]): TemporalContradiction[] {
    const byFact = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const fact = record.tags.find((tag) => tag.startsWith("fact:"));
      if (fact !== undefined) byFact.set(fact, [...(byFact.get(fact) ?? []), record]);
    }
    const contradictions: TemporalContradiction[] = [];
    for (const [factKey, facts] of byFact) {
      const active = facts.filter((record) => record.validUntil === null);
      const contents = new Set(active.map((record) => record.content.trim().toLowerCase()));
      if (contents.size < 2) continue;
      const ordered = [...active].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
      contradictions.push({
        factKey: factKey.slice(5),
        current: ordered[0]!,
        conflicting: ordered.slice(1),
      });
    }
    return contradictions;
  }

  projectKnowledgeGraph(records: readonly MemoryRecord[]): KnowledgeGraphProjection {
    const contradictions = this.detectContradictions(records);
    return {
      nodes: records.map((record) => ({
        id: record.id,
        content: record.content,
        projectId: readProject(record),
        provenance: record.sourceUri ?? record.sourceRunId,
      })),
      edges: [
        ...records.flatMap((record) =>
          record.supersedesId === null
            ? []
            : [{ from: record.id, to: record.supersedesId, type: "SUPERSEDES" as const }],
        ),
        ...contradictions.flatMap((item) =>
          item.conflicting.map((record) => ({
            from: item.current.id,
            to: record.id,
            type: "CONTRADICTS" as const,
          })),
        ),
      ],
    };
  }

  async shareWithAgents(
    userId: string,
    memoryId: string,
    agentIds: readonly string[],
  ): Promise<void> {
    const owned = (
      await this.#provider.search({ userId, query: "", limit: 100_000, includeSuperseded: true })
    ).some((hit) => hit.record.id === memoryId);
    if (!owned) throw new Error("Memory record is unavailable");
    await this.#state.setSharing(userId, memoryId, agentIds);
  }

  async visibleToAgent(
    userId: string,
    agentId: string,
    projectId?: string,
  ): Promise<MemoryRecord[]> {
    const records = (await this.hierarchy(userId, projectId)).archival;
    const visible: MemoryRecord[] = [];
    for (const record of records) {
      if ((await this.#state.sharing(userId, record.id)).includes(agentId)) visible.push(record);
    }
    return visible;
  }

  async setRetention(userId: string, policy: RetentionPolicy): Promise<void> {
    if (policy.maxAgeDays < 1 || policy.minimumImportance < 0 || policy.minimumImportance > 1) {
      throw new RangeError("Invalid retention policy");
    }
    await this.#state.setRetention(userId, policy);
  }

  async applyRetention(userId: string): Promise<{ deletedIds: string[] }> {
    const policies = await this.#state.retention(userId);
    const records = (
      await this.#provider.search({ userId, query: "", limit: 100_000, includeSuperseded: false })
    ).map((hit) => hit.record);
    const deletedIds: string[] = [];
    for (const record of records) {
      const projectId = readProject(record);
      const policy = policies.find((item) => item.projectId === projectId);
      if (policy === undefined || record.importance >= policy.minimumImportance) continue;
      const cutoff = this.#now().getTime() - policy.maxAgeDays * 86_400_000;
      if (record.validFrom.getTime() >= cutoff) continue;
      if (await this.#provider.delete({ userId, id: record.id })) deletedIds.push(record.id);
    }
    return { deletedIds };
  }

  async createImport(userId: string, total: number): Promise<MemoryImportJob> {
    const job: MemoryImportJob = {
      id: randomUUID(),
      userId,
      status: "PENDING",
      processed: 0,
      stored: 0,
      duplicates: 0,
      rejected: 0,
      total,
    };
    await this.#state.saveImport(job);
    return job;
  }

  async cancelImport(userId: string, jobId: string): Promise<void> {
    const job = await this.#state.importJob(jobId);
    if (job?.userId !== userId) throw new Error("Import job is unavailable");
    if (job.status === "PENDING" || job.status === "RUNNING") {
      job.status = "CANCELLED";
      await this.#state.saveImport(job);
    }
  }

  async runImport(
    userId: string,
    jobId: string,
    entries: AsyncIterable<RememberInput>,
  ): Promise<MemoryImportJob> {
    let job = await this.#state.importJob(jobId);
    if (job?.userId !== userId || job?.status !== "PENDING") {
      throw new Error("Import job cannot be started");
    }
    job.status = "RUNNING";
    await this.#state.saveImport(job);
    for await (const entry of entries) {
      job = (await this.#state.importJob(jobId)) ?? job;
      if (job.status === "CANCELLED") return job;
      try {
        const before = await this.#provider.search({ userId, query: entry.content, limit: 50 });
        const record = await this.#service.remember({ ...entry, userId });
        if (before.some((hit) => hit.record.id === record.id)) job.duplicates += 1;
        else job.stored += 1;
      } catch {
        job.rejected += 1;
      }
      job.processed += 1;
      await this.#state.saveImport(job);
    }
    job.status = "COMPLETED";
    await this.#state.saveImport(job);
    return job;
  }
}

const syncEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("upsert"),
    memory: z.object({
      content: z.string(),
      projectId: z.string().nullable(),
      tags: z.array(z.string()),
    }),
  }),
  z.object({ kind: z.literal("delete"), memoryId: z.string().min(1) }),
]);
export type MemorySyncEvent = z.infer<typeof syncEventSchema>;

export interface EncryptedMemoryEnvelope {
  version: 1;
  sourceInstallationId: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export class EncryptedMemorySynchronizer {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new RangeError("Memory sync key must be 32 bytes");
    this.#key = Buffer.from(key);
  }

  encrypt(
    sourceInstallationId: string,
    events: readonly MemorySyncEvent[],
  ): EncryptedMemoryEnvelope {
    const validated = events.map((event) => syncEventSchema.parse(event));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(sourceInstallationId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validated), "utf8"),
      cipher.final(),
    ]);
    return {
      version: 1,
      sourceInstallationId,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  decrypt(envelope: EncryptedMemoryEnvelope): MemorySyncEvent[] {
    if (envelope.version !== 1) throw new Error("Unsupported memory sync envelope");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(envelope.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(envelope.sourceInstallationId));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return z.array(syncEventSchema).parse(JSON.parse(plaintext));
  }

  async apply(
    envelope: EncryptedMemoryEnvelope,
    input: { userId: string; service: MemoryService; provider: MemoryProvider },
  ): Promise<{ upserted: number; deleted: number }> {
    let upserted = 0;
    let deleted = 0;
    for (const event of this.decrypt(envelope)) {
      if (event.kind === "delete") {
        if (await input.provider.delete({ userId: input.userId, id: event.memoryId })) deleted += 1;
      } else {
        await input.service.remember({
          userId: input.userId,
          content: event.memory.content,
          tags: [
            ...event.memory.tags,
            ...(event.memory.projectId === null ? [] : [projectTag(event.memory.projectId)]),
          ],
        });
        upserted += 1;
      }
    }
    return { upserted, deleted };
  }
}

export function projectTag(projectId: string): string {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(projectId)) throw new Error("Invalid project ID");
  return `project:${projectId}`;
}

function readProject(record: MemoryRecord): string | null {
  return record.tags.find((tag) => tag.startsWith("project:"))?.slice(8) ?? null;
}

function toStoreInput(record: MemoryRecord): MemoryStoreInput {
  return {
    userId: record.userId,
    kind: record.kind,
    content: record.content,
    layer: record.layer,
    origin: record.origin,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    sensitivity: record.sensitivity,
    sensitiveCategories: record.sensitiveCategories,
    ...(record.sourceRunId === null ? {} : { sourceRunId: record.sourceRunId }),
    ...(record.sourceConversationId === null
      ? {}
      : { sourceConversationId: record.sourceConversationId }),
    ...(record.sourceMessageId === null ? {} : { sourceMessageId: record.sourceMessageId }),
    ...(record.sourceUri === null ? {} : { sourceUri: record.sourceUri }),
    ...(record.extractedAt === null ? {} : { extractedAt: record.extractedAt }),
  };
}
