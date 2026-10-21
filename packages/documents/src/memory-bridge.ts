import { type DocumentChunk } from "./types.js";
import type { MemoryService, RememberInput } from "@nexus/memory";

export interface DocumentIngestionResult {
  documentId: string;
  filename: string;
  chunksIngested: number;
  citationUris: string[];
}

export type MemorySink = (input: RememberInput) => Promise<unknown>;

/**
 * Injection bridge for document fragments and their precise citations
 * into NEXUS semantic memory (`@nexus/memory`).
 */
export class DocumentMemoryBridge {
  readonly #sink: MemorySink;

  constructor(memoryServiceOrSink: MemoryService | MemorySink) {
    if (typeof memoryServiceOrSink === "function") {
      this.#sink = memoryServiceOrSink;
    } else {
      this.#sink = (input: RememberInput) => memoryServiceOrSink.remember(input);
    }
  }

  /**
   * Ingests a list of document chunks into user memory.
   */
  async ingestChunks(
    chunks: DocumentChunk[],
    options: { userId: string; sourceRunId?: string | undefined },
  ): Promise<DocumentIngestionResult> {
    if (chunks.length === 0) {
      return {
        documentId: "",
        filename: "",
        chunksIngested: 0,
        citationUris: [],
      };
    }

    const citationUris: string[] = [];
    const documentId = chunks[0]?.documentId ?? "doc-unknown";
    const filename = chunks[0]?.filename ?? "document";

    for (const chunk of chunks) {
      const header = [
        `[CITATION: ${chunk.citationUri}]`,
        `Source: ${chunk.citationLabel}`,
        `Path: ${chunk.sectionHierarchy.join(" > ")}`,
        "",
        chunk.content,
      ].join("\n");

      // If chunk has tables, include them legibly
      let finalContent = header;
      if (chunk.tables && chunk.tables.length > 0) {
        finalContent +=
          "\n\nAssociated tables:\n" + chunk.tables.map((t) => t.markdown).join("\n\n");
      }

      await this.#sink({
        userId: options.userId,
        content: finalContent,
        layer: "LONG_TERM",
        kind: "SEMANTIC",
        origin: "SYSTEM",
        importance: 0.8,
        confidence: 0.95,
        tags: ["document", chunk.documentId, chunk.filename, `page-${chunk.pageNumber}`],
        ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
      });

      citationUris.push(chunk.citationUri);
    }

    return {
      documentId,
      filename,
      chunksIngested: chunks.length,
      citationUris,
    };
  }
}
