import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDocumentFormat, DocumentParser } from "../src/parser.js";

describe("multi-format document parser", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-docs-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("detects supported formats from name and bytes", () => {
    expect(detectDocumentFormat("doc.pdf")).toBe("pdf");
    expect(detectDocumentFormat("report.docx")).toBe("docx");
    expect(detectDocumentFormat("presentation.pptx")).toBe("pptx");
    expect(detectDocumentFormat("notes.md")).toBe("md");
    expect(detectDocumentFormat("raw.txt")).toBe("txt");
    expect(detectDocumentFormat("archive.bin", Buffer.from("%PDF-1.7"))).toBe("pdf");
  });

  it("parses Markdown document with sections and tables", async () => {
    const filePath = join(tempDir, "sample.md");
    const content = `
# Main Title

Project introduction.

## Specifications

Here is the components table:

| Component | Version | Status |
| --- | --- | --- |
| Fastify | 5.0 | OK |
| PostgreSQL | 16 | OK |

Rest of the documentation.
    `.trim();

    await writeFile(filePath, content, "utf-8");

    const parser = new DocumentParser();
    const result = await parser.parseDocument(filePath);

    expect(result.format).toBe("md");
    expect(result.filename).toBe("sample.md");
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    expect(result.sections[0]?.title).toBe("Main Title");
    expect(result.sections[1]?.title).toBe("Specifications");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.headers).toEqual(["Component", "Version", "Status"]);
  });
});
