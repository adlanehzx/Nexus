import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";
import {
  archivedEvidenceSchema,
  osintCaseRecordSchema,
  osintEntitySchema,
  osintRelationSchema,
  type ArchivedEvidence,
  type OsintCaseRecord,
  type OsintEntity,
  type OsintRelation,
} from "./case.js";

export interface OsintToolPort {
  get(ownerId: string, caseId: string): Promise<OsintCaseRecord | undefined>;
  addEvidence(
    ownerId: string,
    caseId: string,
    input: {
      url: string;
      title: string;
      excerpt: string;
      reliability: "primary" | "corroborated" | "unverified";
      content: string;
    },
  ): Promise<ArchivedEvidence>;
  addEntity(ownerId: string, caseId: string, input: Omit<OsintEntity, "id">): Promise<OsintEntity>;
  addRelation(
    ownerId: string,
    caseId: string,
    input: Omit<OsintRelation, "id">,
  ): Promise<OsintRelation>;
}

const caseIdSchema = z.object({ caseId: z.string().uuid() });
const evidenceInputSchema = caseIdSchema.extend({
  url: z.string().url(),
  title: z.string().min(1).max(500),
  excerpt: z.string().max(4_000),
  reliability: z.enum(["primary", "corroborated", "unverified"]),
  content: z.string().max(1_000_000),
});
const entityInputSchema = caseIdSchema.extend({
  type: z.string().min(1).max(80),
  label: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});
const relationInputSchema = caseIdSchema.extend({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  label: z.string().min(1).max(160),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().uuid()).max(100),
});

export function createOsintTools(port: OsintToolPort): ToolDefinition<never, unknown>[] {
  const inspect: ToolDefinition<z.infer<typeof caseIdSchema>, OsintCaseRecord> = {
    name: "osint.case.inspect",
    description: "Reads one OSINT case owned by the current user, including evidence and graph.",
    inputSchema: caseIdSchema,
    outputSchema: osintCaseRecordSchema,
    riskLevel: "SAFE",
    requiredPermissions: [],
    requiresConfirmation: false,
    execute: async ({ caseId }, context) => {
      const record = await port.get(context.userId, caseId);
      if (record === undefined) throw new Error("OSINT case not found.");
      return record;
    },
  };
  const evidence: ToolDefinition<z.infer<typeof evidenceInputSchema>, ArchivedEvidence> = {
    name: "osint.evidence.archive",
    description:
      "Archives a public source snapshot with a citation, reliability label and SHA-256 fingerprint in an owned OSINT case.",
    inputSchema: evidenceInputSchema,
    outputSchema: archivedEvidenceSchema,
    riskLevel: "LOW",
    requiredPermissions: [],
    requiresConfirmation: false,
    execute: ({ caseId, ...input }, context) => port.addEvidence(context.userId, caseId, input),
  };
  const entity: ToolDefinition<z.infer<typeof entityInputSchema>, OsintEntity> = {
    name: "osint.entity.add",
    description: "Adds a cited or hypothesized entity to an owned OSINT case graph.",
    inputSchema: entityInputSchema,
    outputSchema: osintEntitySchema,
    riskLevel: "LOW",
    requiredPermissions: [],
    requiresConfirmation: false,
    execute: ({ caseId, ...input }, context) => port.addEntity(context.userId, caseId, input),
  };
  const relation: ToolDefinition<z.infer<typeof relationInputSchema>, OsintRelation> = {
    name: "osint.relation.add",
    description:
      "Adds a confidence-scored relationship between two entities in an owned OSINT case.",
    inputSchema: relationInputSchema,
    outputSchema: osintRelationSchema,
    riskLevel: "LOW",
    requiredPermissions: [],
    requiresConfirmation: false,
    execute: ({ caseId, ...input }, context) => port.addRelation(context.userId, caseId, input),
  };
  return [inspect, evidence, entity, relation] as unknown as ToolDefinition<never, unknown>[];
}
