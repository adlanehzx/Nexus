import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@nexus/tools";
import type { DocumentParser } from "./parser.js";
import { DocumentChunker } from "./chunker.js";
import type { DocumentMemoryBridge } from "./memory-bridge.js";

export const documentParseInputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe("Chemin absolu du document à analyser (PDF, DOCX, PPTX, MD, TXT)"),
});

export const documentParseOutputSchema = z.object({
  id: z.string(),
  filename: string(),
  format: z.string(),
  pageCount: z.number(),
  sectionsCount: z.number(),
  tablesCount: z.number(),
  textPreview: z.string(),
  fullText: z.string(),
});

function string(): z.ZodString {
  return z.string();
}

export const documentExtractTablesInputSchema = z.object({
  filePath: z.string().min(1).describe("Chemin du document dont on souhaite extraire les tableaux"),
});

export const documentExtractTablesOutputSchema = z.object({
  tables: z.array(
    z.object({
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      caption: z.string().optional(),
      pageNumber: z.number().optional(),
      markdown: z.string(),
    }),
  ),
});

export const documentIngestInputSchema = z.object({
  filePath: z.string().min(1).describe("Chemin du document à indexer dans la mémoire"),
  maxChunkSizeChars: z
    .number()
    .int()
    .min(200)
    .max(5000)
    .optional()
    .describe("Taille maximale d'un fragment textuel"),
});

export const documentIngestOutputSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  chunksIngested: z.number(),
  citationUris: z.array(z.string()),
});

/**
 * Crée les outils d'ingestion documentaire et de mémoire pour les agents NEXUS.
 */
export function createDocumentTools(options: {
  parser: DocumentParser;
  memoryBridge?: DocumentMemoryBridge | undefined;
}): ToolDefinition<never, unknown>[] {
  const { parser, memoryBridge } = options;
  const chunker = new DocumentChunker();

  const tools = [
    // 1. document.parse
    {
      name: "document.parse",
      version: "1.0.0",
      description:
        "Extrait le texte structuré et les métadonnées d'un document (PDF, Word, PowerPoint, Markdown).",
      inputSchema: documentParseInputSchema,
      outputSchema: documentParseOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["filesystem.read"],
      requiresConfirmation: false,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof documentParseInputSchema>) =>
        `Analyse du document ${input.filePath}`,
      execute: async (input: z.infer<typeof documentParseInputSchema>, _context: ToolContext) => {
        const parsed = await parser.parseDocument(input.filePath);
        return {
          id: parsed.id,
          filename: parsed.filename,
          format: parsed.format,
          pageCount: parsed.metadata.pageCount,
          sectionsCount: parsed.sections.length,
          tablesCount: parsed.tables.length,
          textPreview: parsed.fullText.slice(0, 300),
          fullText: parsed.fullText,
        };
      },
    },

    // 2. document.extract_tables
    {
      name: "document.extract_tables",
      version: "1.0.0",
      description:
        "Extrait tous les tableaux structurés (en-têtes, colonnes et lignes) d'un document.",
      inputSchema: documentExtractTablesInputSchema,
      outputSchema: documentExtractTablesOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["filesystem.read"],
      requiresConfirmation: false,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof documentExtractTablesInputSchema>) =>
        `Extraction des tableaux de ${input.filePath}`,
      execute: async (
        input: z.infer<typeof documentExtractTablesInputSchema>,
        _context: ToolContext,
      ) => {
        const parsed = await parser.parseDocument(input.filePath);
        return { tables: parsed.tables };
      },
    },

    // 3. document.ingest_to_memory
    {
      name: "document.ingest_to_memory",
      version: "1.0.0",
      description:
        "Découpe un document en fragments structurés avec citations de page/section et les injecte dans la mémoire sémantique NEXUS.",
      inputSchema: documentIngestInputSchema,
      outputSchema: documentIngestOutputSchema,
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.read", "memory.write"],
      requiresConfirmation: false,
      timeoutMs: 60_000,
      summarize: (input: z.infer<typeof documentIngestInputSchema>) =>
        `Indexation en mémoire du document ${input.filePath}`,
      execute: async (input: z.infer<typeof documentIngestInputSchema>, context: ToolContext) => {
        if (!memoryBridge) {
          throw new Error("Aucun pont de mémoire n'est configuré pour l'ingestion documentaire");
        }

        const parsed = await parser.parseDocument(input.filePath);
        const customChunker = input.maxChunkSizeChars
          ? new DocumentChunker({ maxChunkSizeChars: input.maxChunkSizeChars })
          : chunker;

        const chunks = customChunker.chunkDocument(parsed);
        const result = await memoryBridge.ingestChunks(chunks, {
          userId: context.userId,
          sourceRunId: context.runId,
        });

        return result;
      },
    },
  ];

  return tools as unknown as ToolDefinition<never, unknown>[];
}
