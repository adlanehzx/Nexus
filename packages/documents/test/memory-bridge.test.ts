import { describe, expect, it, vi } from "vitest";
import { DocumentMemoryBridge } from "../src/memory-bridge.js";
import { type DocumentChunk } from "../src/types.js";
import type { RememberInput } from "@nexus/memory";

describe("document memory bridge", () => {
  it("injects fragments with full citations into memory sink", async () => {
    const receivedInputs: RememberInput[] = [];
    const mockSink = vi.fn().mockImplementation((input: RememberInput) => {
      receivedInputs.push(input);
      return Promise.resolve();
    });

    const bridge = new DocumentMemoryBridge(mockSink);

    const chunks: DocumentChunk[] = [
      {
        chunkId: "doc-1-chunk-1",
        documentId: "doc-1",
        filename: "Technical_Spec.md",
        pageNumber: 2,
        sectionTitle: "2.1 Security",
        sectionHierarchy: ["2. Architecture", "2.1 Security"],
        content: "All flows are encrypted in transit.",
        citationUri: "doc://doc-1/page/2#2-1-security",
        citationLabel: "Technical_Spec.md (Page 2, § 2.1 Security)",
      },
    ];

    const result = await bridge.ingestChunks(chunks, {
      userId: "user-42",
      sourceRunId: "run-99",
    });

    expect(result.chunksIngested).toBe(1);
    expect(result.citationUris).toEqual(["doc://doc-1/page/2#2-1-security"]);
    expect(receivedInputs).toHaveLength(1);

    const input = receivedInputs[0]!;
    expect(input.userId).toBe("user-42");
    expect(input.sourceRunId).toBe("run-99");
    expect(input.layer).toBe("LONG_TERM");
    expect(input.kind).toBe("SEMANTIC");
    expect(input.origin).toBe("SYSTEM");
    expect(input.content).toContain("[CITATION: doc://doc-1/page/2#2-1-security]");
    expect(input.content).toContain("Technical_Spec.md (Page 2, § 2.1 Security)");
    expect(input.tags).toContain("Technical_Spec.md");
    expect(input.tags).toContain("page-2");
  });
});
