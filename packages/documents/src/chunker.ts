import { type DocumentChunk, type ParsedDocument } from "./types.js";

/**
 * Normalizes a section title into a safe URL anchor fragment.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Builds a stable citation identifier in NEXUS `doc://<id>/page/<num>#<section>` format.
 */
export function buildCitationUri(
  documentId: string,
  pageNumber: number,
  sectionSlug: string,
): string {
  const safeSlug = sectionSlug || "section";
  return `doc://${documentId}/page/${pageNumber}#${safeSlug}`;
}

/**
 * Builds a readable citation label for humans and agent syntheses.
 */
export function buildCitationLabel(
  filename: string,
  pageNumber: number,
  sectionTitle: string,
): string {
  const cleanTitle = sectionTitle ? `§ ${sectionTitle}` : "General";
  return `${filename} (Page ${pageNumber}, ${cleanTitle})`;
}

export interface ChunkerOptions {
  maxChunkSizeChars?: number | undefined;
  overlapChars?: number | undefined;
}

/**
 * Chunks a parsed document into structured fragments (chunks)
 * preserving contextual hierarchy and precise citations.
 */
export class DocumentChunker {
  readonly #maxChunkSizeChars: number;
  readonly #overlapChars: number;

  constructor(options?: ChunkerOptions) {
    this.#maxChunkSizeChars = options?.maxChunkSizeChars ?? 1200;
    this.#overlapChars = options?.overlapChars ?? 150;
  }

  chunkDocument(parsed: ParsedDocument): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const hierarchyTracker: string[] = [];

    for (const section of parsed.sections) {
      // Adjust header hierarchy based on level
      const level = Math.max(1, section.level);
      hierarchyTracker.splice(level - 1);
      hierarchyTracker[level - 1] = section.title;
      const currentHierarchy = hierarchyTracker.filter(Boolean);

      const sectionSlug = slugify(section.title);
      const citationUri = buildCitationUri(parsed.id, section.pageNumber, sectionSlug);
      const citationLabel = buildCitationLabel(parsed.filename, section.pageNumber, section.title);

      const fullSectionText = section.content.trim();

      // If the section contains tables, attach them
      const sectionTables = section.tables.length > 0 ? section.tables : undefined;

      if (fullSectionText.length <= this.#maxChunkSizeChars) {
        chunks.push({
          chunkId: `${parsed.id}-chunk-${chunks.length + 1}`,
          documentId: parsed.id,
          filename: parsed.filename,
          pageNumber: section.pageNumber,
          sectionTitle: section.title,
          sectionHierarchy: currentHierarchy,
          content: fullSectionText,
          citationUri,
          citationLabel,
          ...(sectionTables ? { tables: sectionTables } : {}),
        });
      } else {
        // Sliding window chunking with overlap
        const paragraphs = fullSectionText.split("\n\n");
        let currentWindow = "";

        for (const p of paragraphs) {
          if (
            currentWindow.length > 0 &&
            currentWindow.length + p.length > this.#maxChunkSizeChars
          ) {
            chunks.push({
              chunkId: `${parsed.id}-chunk-${chunks.length + 1}`,
              documentId: parsed.id,
              filename: parsed.filename,
              pageNumber: section.pageNumber,
              sectionTitle: section.title,
              sectionHierarchy: currentHierarchy,
              content: currentWindow.trim(),
              citationUri,
              citationLabel,
            });

            // Overlap
            const overlapPart = currentWindow.slice(-this.#overlapChars);
            currentWindow = overlapPart + "\n\n" + p;
          } else {
            currentWindow = currentWindow.length === 0 ? p : `${currentWindow}\n\n${p}`;
          }
        }

        if (currentWindow.trim().length > 0) {
          chunks.push({
            chunkId: `${parsed.id}-chunk-${chunks.length + 1}`,
            documentId: parsed.id,
            filename: parsed.filename,
            pageNumber: section.pageNumber,
            sectionTitle: section.title,
            sectionHierarchy: currentHierarchy,
            content: currentWindow.trim(),
            citationUri,
            citationLabel,
            ...(sectionTables ? { tables: sectionTables } : {}),
          });
        }
      }
    }

    // If no fragment was produced (e.g. document without explicit sections), chunk raw text
    if (chunks.length === 0 && parsed.fullText.trim().length > 0) {
      chunks.push({
        chunkId: `${parsed.id}-chunk-${chunks.length + 1}`,
        documentId: parsed.id,
        filename: parsed.filename,
        pageNumber: 1,
        sectionTitle: "Main document",
        sectionHierarchy: ["Main document"],
        content: parsed.fullText.trim().slice(0, this.#maxChunkSizeChars),
        citationUri: buildCitationUri(parsed.id, 1, "main-document"),
        citationLabel: buildCitationLabel(parsed.filename, 1, "Main document"),
        ...(parsed.tables.length > 0 ? { tables: parsed.tables } : {}),
      });
    }

    return chunks;
  }
}
