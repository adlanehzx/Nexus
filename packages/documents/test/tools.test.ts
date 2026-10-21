import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentParser } from "../src/parser.js";
import { DocumentMemoryBridge } from "../src/memory-bridge.js";
import { createDocumentTools } from "../src/tools.js";
import type { ToolContext, ToolDefinition } from "@nexus/tools";

describe("Outils documentaires NEXUS", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-tools-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createMockContext = (): ToolContext => ({
    runId: "run-doc-1",
    userId: "user-test",
    conversationId: "conv-1",
    correlationId: "corr-1",
    signal: new AbortController().signal,
    idempotencyKey: "idem-doc",
    attempt: 1,
    onProgress: vi.fn(),
  });

  it("enregistre les outils avec leurs permissions et niveaux de risque", () => {
    const parser = new DocumentParser();
    const tools = createDocumentTools({ parser });

    const names = tools.map((t) => t.name);
    expect(names).toContain("document.parse");
    expect(names).toContain("document.extract_tables");
    expect(names).toContain("document.ingest_to_memory");

    const parseTool = tools.find((t) => t.name === "document.parse")!;
    expect(parseTool.riskLevel).toBe("SAFE");
    expect(parseTool.requiredPermissions).toEqual(["filesystem.read"]);

    const ingestTool = tools.find((t) => t.name === "document.ingest_to_memory")!;
    expect(ingestTool.riskLevel).toBe("MEDIUM");
    expect(ingestTool.requiredPermissions).toContain("memory.write");
  });

  it("exécute document.parse et document.extract_tables sur un fichier réel", async () => {
    const filePath = join(tempDir, "document.md");
    await writeFile(
      filePath,
      "# Titre\n\nContenu.\n\n| Col 1 | Col 2 |\n| --- | --- |\n| Val 1 | Val 2 |",
      "utf-8",
    );

    const parser = new DocumentParser();
    const tools = createDocumentTools({ parser });

    const parseTool = tools.find((t) => t.name === "document.parse")! as unknown as ToolDefinition<
      { filePath: string },
      { id: string; filename: string; tablesCount: number }
    >;
    const extractTablesTool = tools.find((t) => t.name === "document.extract_tables")! as unknown as ToolDefinition<
      { filePath: string },
      { tables: { headers: string[] }[] }
    >;

    const ctx = createMockContext();
    const parseRes = await parseTool.execute({ filePath }, ctx);
    expect(parseRes.filename).toBe("document.md");
    expect(parseRes.tablesCount).toBe(1);

    const tablesRes = await extractTablesTool.execute({ filePath }, ctx);
    expect(tablesRes.tables).toHaveLength(1);
    expect(tablesRes.tables[0]?.headers).toEqual(["Col 1", "Col 2"]);
  });

  it("exécute document.ingest_to_memory et alimente le pont de mémoire", async () => {
    const filePath = join(tempDir, "doc-to-ingest.md");
    await writeFile(filePath, "# Section 1\n\nInformation critique.", "utf-8");

    const parser = new DocumentParser();
    const mockSink = vi.fn().mockResolvedValue(undefined);
    const bridge = new DocumentMemoryBridge(mockSink);

    const tools = createDocumentTools({ parser, memoryBridge: bridge });
    const ingestTool = tools.find((t) => t.name === "document.ingest_to_memory")! as unknown as ToolDefinition<
      { filePath: string },
      { chunksIngested: number; citationUris: string[] }
    >;

    const ctx = createMockContext();
    const result = await ingestTool.execute({ filePath }, ctx);

    expect(result.chunksIngested).toBeGreaterThanOrEqual(1);
    expect(result.citationUris.length).toBeGreaterThanOrEqual(1);
    expect(mockSink).toHaveBeenCalled();
  });
});
