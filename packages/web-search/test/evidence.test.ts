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
      language: "en",
    },
    provenance: { redirectChain: [], untrustedExternalContent: true },
  };
}

describe("web evidence", () => {
  it("verifies an exact citation and claim token coverage", () => {
    const source = document(
      "https://example.org/a",
      "NEXUS uses local search without paid API keys.",
    );
    const citation = createCitation(
      source,
      "NEXUS uses local search without paid API keys.",
      "NEXUS search is local and needs no paid API key",
    );

    expect(citation.verified).toBe(true);
    expect(citation.startOffset).toBe(0);
    expect(citation.verification.claimTokenCoverage).toBeGreaterThanOrEqual(0.5);
    expect(verifyCitation(citation, source).verified).toBe(true);
  });

  it("rejects fabricated citations or citations from another document version", () => {
    const source = document("https://example.org/a", "Actually published text.");
    expect(createCitation(source, "Fabricated text.").verified).toBe(false);
    const valid = createCitation(source, "Actually published text.");
    const changed = document("https://example.org/a", "New version.");
    expect(verifyCitation(valid, changed).verified).toBe(false);
  });

  it("suggests only extractive citations", () => {
    const source = document(
      "https://example.org/a",
      "This paragraph contains enough text to qualify as a verifiable extractive citation.\nShort.",
    );
    const citations = suggestCitations(source);
    expect(citations).toHaveLength(1);
    expect(source.content).toContain(citations[0]?.quote);
    expect(citations[0]?.verified).toBe(true);
  });

  it("deduplicates by canonical URL first, then by content hash", () => {
    const first = document(
      "https://example.org/a?utm_source=x",
      "Content one",
      "https://example.org/a",
    );
    const canonicalDuplicate = document(
      "https://example.org/a?ref=two",
      "Other",
      "https://example.org/a",
    );
    const hashDuplicate = document("https://mirror.example.net/a", "Content one");
    const result = deduplicateDocuments([first, canonicalDuplicate, hashDuplicate]);

    expect(result.documents).toEqual([first]);
    expect(result.duplicates.map(({ reason }) => reason)).toEqual([
      "canonical_url",
      "content_hash",
    ]);
  });
});
