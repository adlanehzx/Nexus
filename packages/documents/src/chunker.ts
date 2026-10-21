import {
  type DocumentChunk,
  type ParsedDocument,
} from "./types.js";

/**
 * Normalise un titre de section en fragment d'ancre d'URL sûr.
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
 * Construit un identifiant de citation stable au format NEXUS `doc://<id>/page/<num>#<section>`.
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
 * Construit un libellé de citation lisible pour l'humain et les synthèses des agents.
 */
export function buildCitationLabel(
  filename: string,
  pageNumber: number,
  sectionTitle: string,
): string {
  const cleanTitle = sectionTitle ? `§ ${sectionTitle}` : "Général";
  return `${filename} (Page ${pageNumber}, ${cleanTitle})`;
}

export interface ChunkerOptions {
  maxChunkSizeChars?: number | undefined;
  overlapChars?: number | undefined;
}

/**
 * Découpe un document analysé en fragments structurés (chunks)
 * conservant la hiérarchie contextuelle et leurs citations précises.
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
      // Ajuste la hiérarchie des titres selon le niveau
      const level = Math.max(1, section.level);
      hierarchyTracker.splice(level - 1);
      hierarchyTracker[level - 1] = section.title;
      const currentHierarchy = hierarchyTracker.filter(Boolean);

      const sectionSlug = slugify(section.title);
      const citationUri = buildCitationUri(parsed.id, section.pageNumber, sectionSlug);
      const citationLabel = buildCitationLabel(parsed.filename, section.pageNumber, section.title);

      const fullSectionText = section.content.trim();

      // Si la section contient des tableaux, on les attache
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
        // Découpage en fenêtres avec recouvrement
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

            // Recouvrement
            const overlapPart = currentWindow.slice(-this.#overlapChars);
            currentWindow = overlapPart + "\n\n" + p;
          } else {
            currentWindow =
              currentWindow.length === 0 ? p : `${currentWindow}\n\n${p}`;
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

    // Si aucun fragment n'a été produit (ex: document sans sections explicites), découpe le texte brut
    if (chunks.length === 0 && parsed.fullText.trim().length > 0) {
      chunks.push({
        chunkId: `${parsed.id}-chunk-${chunks.length + 1}`,
        documentId: parsed.id,
        filename: parsed.filename,
        pageNumber: 1,
        sectionTitle: "Document principal",
        sectionHierarchy: ["Document principal"],
        content: parsed.fullText.trim().slice(0, this.#maxChunkSizeChars),
        citationUri: buildCitationUri(parsed.id, 1, "document-principal"),
        citationLabel: buildCitationLabel(parsed.filename, 1, "Document principal"),
        ...(parsed.tables.length > 0 ? { tables: parsed.tables } : {}),
      });
    }

    return chunks;
  }
}
