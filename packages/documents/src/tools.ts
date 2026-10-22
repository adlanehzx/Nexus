import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@nexus/tools";
import type { DocumentParser } from "./parser.js";
import { DocumentChunker } from "./chunker.js";
import type { DocumentMemoryBridge } from "./memory-bridge.js";

export const documentParseInputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe("Absolute path to the document to parse (PDF, DOCX, PPTX, MD, TXT)"),
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
  filePath: z.string().min(1).describe("Path to the document from which to extract tables"),
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
  filePath: z.string().min(1).describe("Path to the document to ingest into memory"),
  maxChunkSizeChars: z
    .number()
    .int()
    .min(200)
    .max(5000)
    .optional()
    .describe("Maximum size of a text chunk in characters"),
});

export const documentIngestOutputSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  chunksIngested: z.number(),
  citationUris: z.array(z.string()),
});

/**
 * Creates document ingestion and memory tools for NEXUS agents.
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
        "Extracts structured text and metadata from a document (PDF, Word, PowerPoint, Markdown).",
      inputSchema: documentParseInputSchema,
      outputSchema: documentParseOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["filesystem.read"],
      requiresConfirmation: false,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof documentParseInputSchema>) =>
        `Parse document ${input.filePath}`,
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
      description: "Extracts all structured tables (headers, columns, and rows) from a document.",
      inputSchema: documentExtractTablesInputSchema,
      outputSchema: documentExtractTablesOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["filesystem.read"],
      requiresConfirmation: false,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof documentExtractTablesInputSchema>) =>
        `Extract tables from ${input.filePath}`,
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
        "Chunks a document into structured fragments with page/section citations and injects them into NEXUS semantic memory.",
      inputSchema: documentIngestInputSchema,
      outputSchema: documentIngestOutputSchema,
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.read", "memory.write"],
      requiresConfirmation: false,
      timeoutMs: 60_000,
      summarize: (input: z.infer<typeof documentIngestInputSchema>) =>
        `Ingest document ${input.filePath} into memory`,
      execute: async (input: z.infer<typeof documentIngestInputSchema>, context: ToolContext) => {
        if (!memoryBridge) {
          throw new Error("No memory bridge is configured for document ingestion");
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
