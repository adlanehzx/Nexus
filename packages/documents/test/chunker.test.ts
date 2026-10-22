import { describe, expect, it } from "vitest";
import { buildCitationLabel, buildCitationUri, DocumentChunker, slugify } from "../src/chunker.js";
import { type ParsedDocument } from "../src/types.js";

describe("hierarchical chunking and document citations", () => {
  it("normalizes a section title into a slug for citation", () => {
    expect(slugify("1.1 Introduction and Context !")).toBe("1-1-introduction-and-context");
    expect(slugify("Technical Specification")).toBe("technical-specification");
  });

  it("generates stable citation identifiers and labels", () => {
    const uri = buildCitationUri("doc-abc123", 4, "network-architecture");
    expect(uri).toBe("doc://doc-abc123/page/4#network-architecture");

    const label = buildCitationLabel("Security_Audit.pdf", 4, "Network Architecture");
    expect(label).toBe("Security_Audit.pdf (Page 4, § Network Architecture)");
  });

  it("chunks document while preserving section parent hierarchy", () => {
    const mockDoc: ParsedDocument = {
      id: "doc-test-1",
      filename: "Architecture_Manual.pdf",
      format: "pdf",
      metadata: { pageCount: 2, fileSizeBytes: 1024, sha256: "abc" },
      sections: [
        {
          title: "Chapter 1: Overview",
          level: 1,
          pageNumber: 1,
          content: "General introduction to the NEXUS system.",
          tables: [],
        },
        {
          title: "1.1 MCP Isolation",
          level: 2,
          pageNumber: 1,
          content: "MCP isolation relies on Bubblewrap and Linux namespaces.",
          tables: [],
        },
        {
          title: "Chapter 2: Protocols",
          level: 1,
          pageNumber: 2,
          content: "Details on exchange protocols.",
          tables: [],
        },
      ],
      fullText: "Full content",
      tables: [],
      parserUsed: "local",
    };

    const chunker = new DocumentChunker();
    const chunks = chunker.chunkDocument(mockDoc);

    expect(chunks).toHaveLength(3);

    // Verify chunk 1.1 and its preserved parent hierarchy
    const chunkSub = chunks[1];
    expect(chunkSub?.sectionTitle).toBe("1.1 MCP Isolation");
    expect(chunkSub?.sectionHierarchy).toEqual(["Chapter 1: Overview", "1.1 MCP Isolation"]);
    expect(chunkSub?.citationUri).toBe("doc://doc-test-1/page/1#1-1-mcp-isolation");
    expect(chunkSub?.citationLabel).toContain(
      "Architecture_Manual.pdf (Page 1, § 1.1 MCP Isolation)",
    );
  });
});
