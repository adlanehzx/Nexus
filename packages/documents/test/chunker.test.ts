import { describe, expect, it } from "vitest";
import { buildCitationLabel, buildCitationUri, DocumentChunker, slugify } from "../src/chunker.js";
import { type ParsedDocument } from "../src/types.js";

describe("Découpage hiérarchique et citations documentaires", () => {
  it("normalise un titre de section en slug pour citation", () => {
    expect(slugify("1.1 Introduction et Contexte !")).toBe("1-1-introduction-et-contexte");
    expect(slugify("Spécification Technique Électrique")).toBe(
      "specification-technique-electrique",
    );
  });

  it("génère des identifiants et libellés de citation stables", () => {
    const uri = buildCitationUri("doc-abc123", 4, "architecture-reseau");
    expect(uri).toBe("doc://doc-abc123/page/4#architecture-reseau");

    const label = buildCitationLabel("Audit_Securite.pdf", 4, "Architecture Réseau");
    expect(label).toBe("Audit_Securite.pdf (Page 4, § Architecture Réseau)");
  });

  it("découpe un document en conservant la hiérarchie parentale des sections", () => {
    const mockDoc: ParsedDocument = {
      id: "doc-test-1",
      filename: "Manuel_Architecture.pdf",
      format: "pdf",
      metadata: { pageCount: 2, fileSizeBytes: 1024, sha256: "abc" },
      sections: [
        {
          title: "Chapitre 1 : Vue d'ensemble",
          level: 1,
          pageNumber: 1,
          content: "Introduction générale au système NEXUS.",
          tables: [],
        },
        {
          title: "1.1 Isolation MCP",
          level: 2,
          pageNumber: 1,
          content: "L'isolation MCP repose sur Bubblewrap et les namespaces Linux.",
          tables: [],
        },
        {
          title: "Chapitre 2 : Protocoles",
          level: 1,
          pageNumber: 2,
          content: "Détail des protocoles d'échange.",
          tables: [],
        },
      ],
      fullText: "Contenu complet",
      tables: [],
      parserUsed: "local",
    };

    const chunker = new DocumentChunker();
    const chunks = chunker.chunkDocument(mockDoc);

    expect(chunks).toHaveLength(3);

    // Vérifie le chunk 1.1 et sa hiérarchie parentale conservée
    const chunkSub = chunks[1];
    expect(chunkSub?.sectionTitle).toBe("1.1 Isolation MCP");
    expect(chunkSub?.sectionHierarchy).toEqual([
      "Chapitre 1 : Vue d'ensemble",
      "1.1 Isolation MCP",
    ]);
    expect(chunkSub?.citationUri).toBe("doc://doc-test-1/page/1#1-1-isolation-mcp");
    expect(chunkSub?.citationLabel).toContain(
      "Manuel_Architecture.pdf (Page 1, § 1.1 Isolation MCP)",
    );
  });
});
