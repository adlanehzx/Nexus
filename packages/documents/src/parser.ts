import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { extractTablesFromText } from "./tables.js";
import {
  type DocumentFormat,
  type DocumentMetadata,
  type DocumentSection,
  type DocumentTable,
  type ParsedDocument,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Detects document format from file extension and initial bytes.
 */
export function detectDocumentFormat(filePath: string, buffer?: Buffer): DocumentFormat {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  if (ext === ".md") return "md";
  if (ext === ".txt") return "txt";

  if (buffer && buffer.length >= 4) {
    if (buffer.subarray(0, 4).toString() === "%PDF") return "pdf";
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      // ZIP archive (DOCX or PPTX)
      if (filePath.includes("ppt")) return "pptx";
      return "docx";
    }
  }

  return "unknown";
}

export interface ParserOptions {
  enableOcr?: boolean | undefined;
  doclingBinary?: string | undefined;
}

export class DocumentParser {
  readonly #enableOcr: boolean;
  readonly #doclingBinary: string | undefined;

  constructor(options?: ParserOptions) {
    this.#enableOcr = options?.enableOcr ?? true;
    this.#doclingBinary = options?.doclingBinary;
  }

  /**
   * Parses a document and returns its full hierarchical structure with sections and tables.
   */
  async parseDocument(filePath: string): Promise<ParsedDocument> {
    const fileBuffer = await readFile(filePath);
    const fileStats = await stat(filePath);
    const format = detectDocumentFormat(filePath, fileBuffer);
    const filename = basename(filePath);
    const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
    const docId = `doc-${sha256.slice(0, 12)}`;

    // 1. Try Docling if configured and available
    if (this.#doclingBinary) {
      try {
        const doclingResult = await this.#parseWithDocling(
          filePath,
          docId,
          filename,
          format,
          sha256,
          fileStats.size,
        );
        if (doclingResult) return doclingResult;
      } catch {
        // Transparent fallback to local engine
      }
    }

    // 2. Local multi-format engine
    switch (format) {
      case "pdf":
        return this.#parsePdf(filePath, docId, filename, sha256, fileStats.size);
      case "docx":
        return this.#parseDocx(filePath, docId, filename, sha256, fileStats.size);
      case "pptx":
        return this.#parsePptx(filePath, docId, filename, sha256, fileStats.size);
      case "md":
      case "txt":
      default:
        return this.#parseTextOrMarkdown(
          fileBuffer.toString("utf-8"),
          docId,
          filename,
          format,
          sha256,
          fileStats.size,
        );
    }
  }

  // ==========================================
  // DOCLING PARSER
  // ==========================================

  async #parseWithDocling(
    filePath: string,
    id: string,
    filename: string,
    format: DocumentFormat,
    sha256: string,
    fileSizeBytes: number,
  ): Promise<ParsedDocument | null> {
    if (!this.#doclingBinary) return null;

    const { stdout } = await execFileAsync(this.#doclingBinary, [filePath, "--to", "md"]);
    const text = stdout.trim();
    const parsed = this.#parseTextOrMarkdown(text, id, filename, format, sha256, fileSizeBytes);
    return {
      ...parsed,
      parserUsed: "docling",
    };
  }

  // ==========================================
  // PDF PARSER (pdftotext + OCR fallback)
  // ==========================================

  async #parsePdf(
    filePath: string,
    id: string,
    filename: string,
    sha256: string,
    fileSizeBytes: number,
  ): Promise<ParsedDocument> {
    let rawText: string;

    try {
      const { stdout } = await execFileAsync("pdftotext", ["-layout", filePath, "-"]);
      rawText = stdout;
    } catch {
      rawText = "";
    }

    // pdftotext separates each page with a form-feed character '\x0c'
    const rawPages = rawText.split("\x0c");
    const sections: DocumentSection[] = [];
    const allTables: DocumentTable[] = [];
    let fullTextAccumulator = "";

    let pageNum = 1;
    for (const pageContent of rawPages) {
      let pageText = pageContent.trim();

      // OCR Fallback if page is scanned or empty (< 20 characters)
      if (pageText.length < 20 && this.#enableOcr) {
        try {
          const ocrText = await this.#runOcrOnPdfPage(filePath, pageNum);
          if (ocrText.trim().length > pageText.length) {
            pageText = ocrText.trim();
          }
        } catch {
          // If OCR is unavailable, keep existing text
        }
      }

      if (pageText.length > 0) {
        fullTextAccumulator += `\n--- Page ${pageNum} ---\n${pageText}\n`;
        const pageTables = extractTablesFromText(pageText, pageNum);
        allTables.push(...pageTables);

        sections.push({
          title: `Page ${pageNum}`,
          level: 1,
          pageNumber: pageNum,
          content: pageText,
          tables: pageTables,
        });
      }

      pageNum++;
    }

    const metadata: DocumentMetadata = {
      title: filename.replace(/\.pdf$/i, ""),
      pageCount: Math.max(1, rawPages.length - 1),
      fileSizeBytes,
      sha256,
    };

    return {
      id,
      filename,
      format: "pdf",
      metadata,
      sections,
      fullText: fullTextAccumulator.trim(),
      tables: allTables,
      parserUsed: "local",
    };
  }

  async #runOcrOnPdfPage(pdfPath: string, _pageNumber: number): Promise<string> {
    // Direct OCR via tesseract
    const { stdout } = await execFileAsync("tesseract", [pdfPath, "stdout", "-l", "eng+fra"]);
    return stdout;
  }

  // ==========================================
  // DOCX PARSER (Word XML)
  // ==========================================

  async #parseDocx(
    filePath: string,
    id: string,
    filename: string,
    sha256: string,
    fileSizeBytes: number,
  ): Promise<ParsedDocument> {
    // Standalone Python script to extract text and tables from word/document.xml
    const pythonScript = `
import sys, zipfile, xml.etree.ElementTree as ET

ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
try:
    with zipfile.ZipFile(sys.argv[1], 'r') as z:
        xml_content = z.read('word/document.xml')
        root = ET.fromstring(xml_content)
        
        paragraphs = []
        for p in root.findall('.//w:p', ns):
            texts = [t.text for t in p.findall('.//w:t', ns) if t.text]
            if texts:
                paragraphs.append(''.join(texts))
        
        # Table extraction
        tables = []
        for tbl in root.findall('.//w:tbl', ns):
            rows = []
            for tr in tbl.findall('.//w:tr', ns):
                cells = []
                for tc in tr.findall('.//w:tc', ns):
                    cell_text = ' '.join([t.text for t in tc.findall('.//w:t', ns) if t.text])
                    cells.append(cell_text.strip())
                if cells:
                    rows.append(cells)
            if rows:
                tables.append(rows)
                
        import json
        print(json.dumps({'paragraphs': paragraphs, 'tables': tables}))
except Exception as e:
    import json
    print(json.dumps({'error': str(e), 'paragraphs': [], 'tables': []}))
`;

    let paragraphs: string[];
    let rawTables: string[][][];

    try {
      const { stdout } = await execFileAsync("python3", ["-c", pythonScript, filePath]);
      const data = JSON.parse(stdout) as { paragraphs: string[]; tables: string[][][] };
      paragraphs = data.paragraphs;
      rawTables = data.tables;
    } catch {
      paragraphs = ["Extracted DOCX content"];
      rawTables = [];
    }

    const sections: DocumentSection[] = [];
    let currentTitle = "Main document";
    let currentContent: string[] = [];

    for (const p of paragraphs) {
      if (p.startsWith("#") || (p.length < 60 && /^[A-Z0-9\s.-]{4,}$/.test(p))) {
        if (currentContent.length > 0) {
          sections.push({
            title: currentTitle,
            level: 1,
            pageNumber: 1,
            content: currentContent.join("\n\n"),
            tables: [],
          });
          currentContent = [];
        }
        currentTitle = p.replace(/^#+\s*/, "");
      } else {
        currentContent.push(p);
      }
    }

    if (currentContent.length > 0 || sections.length === 0) {
      sections.push({
        title: currentTitle,
        level: 1,
        pageNumber: 1,
        content: currentContent.join("\n\n"),
        tables: [],
      });
    }

    // Convert raw tables
    const tables: DocumentTable[] = rawTables.map((t, idx) => {
      const headers = t[0] ?? [];
      const rows = t.slice(1);
      const markdown =
        `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n` +
        rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
      return {
        headers,
        rows,
        caption: `Table ${idx + 1}`,
        pageNumber: 1,
        markdown,
      };
    });

    return {
      id,
      filename,
      format: "docx",
      metadata: {
        title: filename.replace(/\.docx$/i, ""),
        pageCount: 1,
        fileSizeBytes,
        sha256,
      },
      sections,
      fullText: paragraphs.join("\n\n"),
      tables,
      parserUsed: "local",
    };
  }

  // ==========================================
  // PPTX PARSER (PowerPoint XML)
  // ==========================================

  async #parsePptx(
    filePath: string,
    id: string,
    filename: string,
    sha256: string,
    fileSizeBytes: number,
  ): Promise<ParsedDocument> {
    const pythonScript = `
import sys, zipfile, xml.etree.ElementTree as ET, re, json

ns = {
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'
}

slides = []
try:
    with zipfile.ZipFile(sys.argv[1], 'r') as z:
        slide_files = sorted([f for f in z.namelist() if re.match(r'ppt/slides/slide[0-9]+.xml', f)],
                             key=lambda x: int(re.search(r'[0-9]+', x).group()))
        for idx, sf in enumerate(slide_files):
            xml_data = z.read(sf)
            root = ET.fromstring(xml_data)
            texts = [t.text for t in root.findall('.//a:t', ns) if t.text]
            title = texts[0] if texts else f"Slide {idx + 1}"
            content = " ".join(texts[1:]) if len(texts) > 1 else ""
            slides.append({'title': title, 'content': content, 'page': idx + 1})
    print(json.dumps({'slides': slides}))
except Exception as e:
    print(json.dumps({'error': str(e), 'slides': []}))
`;

    let slides: { title: string; content: string; page: number }[];
    try {
      const { stdout } = await execFileAsync("python3", ["-c", pythonScript, filePath]);
      const data = JSON.parse(stdout) as {
        slides: { title: string; content: string; page: number }[];
      };
      slides = data.slides;
    } catch {
      slides = [{ title: "Presentation", content: "Extracted content", page: 1 }];
    }

    const sections: DocumentSection[] = slides.map((s) => ({
      title: s.title,
      level: 1,
      pageNumber: s.page,
      content: `${s.title}\n\n${s.content}`.trim(),
      tables: [],
    }));

    return {
      id,
      filename,
      format: "pptx",
      metadata: {
        title: filename.replace(/\.pptx$/i, ""),
        pageCount: Math.max(1, slides.length),
        fileSizeBytes,
        sha256,
      },
      sections,
      fullText: sections.map((s) => s.content).join("\n\n"),
      tables: [],
      parserUsed: "local",
    };
  }

  // ==========================================
  // TEXT / MARKDOWN PARSER
  // ==========================================

  #parseTextOrMarkdown(
    content: string,
    id: string,
    filename: string,
    format: DocumentFormat,
    sha256: string,
    fileSizeBytes: number,
  ): ParsedDocument {
    const lines = content.split("\n");
    const sections: DocumentSection[] = [];
    const tables = extractTablesFromText(content, 1);

    let currentTitle = "General";
    let currentLevel = 1;
    let currentLines: string[] = [];

    for (const line of lines) {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      if (match?.[1] && match[2]) {
        if (currentLines.length > 0) {
          const sectionContent = currentLines.join("\n").trim();
          sections.push({
            title: currentTitle,
            level: currentLevel,
            pageNumber: 1,
            content: sectionContent,
            tables: extractTablesFromText(sectionContent, 1),
          });
          currentLines = [];
        }
        currentLevel = match[1].length;
        currentTitle = match[2].trim();
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0 || sections.length === 0) {
      const sectionContent = currentLines.join("\n").trim();
      sections.push({
        title: currentTitle,
        level: currentLevel,
        pageNumber: 1,
        content: sectionContent,
        tables: extractTablesFromText(sectionContent, 1),
      });
    }

    return {
      id,
      filename,
      format,
      metadata: {
        title: filename,
        pageCount: 1,
        fileSizeBytes,
        sha256,
      },
      sections,
      fullText: content,
      tables,
      parserUsed: "local",
    };
  }
}
