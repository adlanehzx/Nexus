import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCitation,
  deduplicateDocuments,
  suggestCitations,
  verifyCitation,
  type WebDocument,
} from "../src/index.js";

function document(url: string, content: string, canonicalUrl = url): WebDocument {
  return {
    requestedUrl: url,
    finalUrl: url,
    canonicalUrl,
    contentType: "text/html",
    fetchedAt: "2026-10-20T12:00:00.000Z",
    sha256: createHash("sha256").update(content).digest("hex"),
    byteLength: Buffer.byteLength(content),
    wordCount: content.split(/\s+/).length,
    content,
    metadata: {
      title: "Source",
      description: null,
      author: null,
      publishedAt: null,
      language: "fr",
    },
    provenance: { redirectChain: [], untrustedExternalContent: true },
  };
}

describe("preuves web", () => {
  it("vérifie une citation exacte et la couverture lexicale de l'affirmation", () => {
    const source = document(
      "https://example.org/a",
      "NEXUS utilise une recherche locale sans clé API payante.",
    );
    const citation = createCitation(
      source,
      "NEXUS utilise une recherche locale sans clé API payante.",
      "La recherche NEXUS est locale et sans clé payante",
    );

    expect(citation.verified).toBe(true);
    expect(citation.startOffset).toBe(0);
    expect(citation.verification.claimTokenCoverage).toBeGreaterThanOrEqual(0.5);
    expect(verifyCitation(citation, source).verified).toBe(true);
  });

  it("refuse une citation inventée ou issue d'une autre version", () => {
    const source = document("https://example.org/a", "Texte réellement publié.");
    expect(createCitation(source, "Texte inventé.").verified).toBe(false);
    const valid = createCitation(source, "Texte réellement publié.");
    const changed = document("https://example.org/a", "Nouvelle version.");
    expect(verifyCitation(valid, changed).verified).toBe(false);
  });

  it("propose uniquement des citations extractives", () => {
    const source = document(
      "https://example.org/a",
      "Ce paragraphe contient assez de texte pour devenir une citation extractive utile et contrôlable.\nCourt.",
    );
    const citations = suggestCitations(source);
    expect(citations).toHaveLength(1);
    expect(source.content).toContain(citations[0]?.quote);
    expect(citations[0]?.verified).toBe(true);
  });

  it("déduplique d'abord par URL canonique puis par hash de contenu", () => {
    const first = document(
      "https://example.org/a?utm_source=x",
      "Contenu un",
      "https://example.org/a",
    );
    const canonicalDuplicate = document(
      "https://example.org/a?ref=two",
      "Autre",
      "https://example.org/a",
    );
    const hashDuplicate = document("https://mirror.example.net/a", "Contenu un");
    const result = deduplicateDocuments([first, canonicalDuplicate, hashDuplicate]);

    expect(result.documents).toEqual([first]);
    expect(result.duplicates.map(({ reason }) => reason)).toEqual([
      "canonical_url",
      "content_hash",
    ]);
  });
});
