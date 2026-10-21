# 31. Advanced Document Processing (Docling, PDF, OCR, and Memory)

## 1. Context and Goals

To enable NEXUS agents to analyze complex enterprise documents and produce verifiable responses without hallucination, document processing provides:

1. **Universal Multi-Format Support**: Native ingestion of PDF (`.pdf`), Word (`.docx`), PowerPoint (`.pptx`), Markdown (`.md`), and plaintext (`.txt`).
2. **Docling Integration & High-Fidelity Local Fallback**:
   - Automatic detection and delegation to Docling when available.
   - High-fidelity local engine using `pdftotext` (layout-preserving pagination) and `tesseract` OCR for scanned documents lacking a text layer.
   - Office file parsing (Word, PowerPoint) via structured XML inspection (`word/document.xml`, `ppt/slides/slide*.xml`).
3. **Structured Table Extraction**:
   - Automated detection and parsing of tables into matrix representations `{ headers, rows }` and Markdown tables.
4. **Hierarchical Chunking**:
   - Structured chunking by section and page, preserving parent hierarchy (e.g. `H1 > H2`).
   - Verifiable and stable citation anchors: `doc://<documentId>/page/<pageNumber>#<sectionSlug>`.
   - Human-readable citation label: `Security_Report.pdf (Page 3, § 2.1 Network Audit)`.
5. **NEXUS Memory Injection (`@nexus/memory`)**:
   - `DocumentMemoryBridge` injects structured chunks and citations directly into long-term semantic memory (`LONG_TERM`, `SEMANTIC`).

## 2. Technical Architecture (`@nexus/documents`)

```
Document File (.pdf, .docx, .pptx, .md)
            │
            ▼
    detectDocumentFormat()
            │
            ├─► Docling (when configured)
            └─► Local Engine:
                  ├─ pdftotext (-layout + form feed \x0c)
                  ├─ Tesseract OCR (fallback when < 20 chars)
                  ├─ Office XML (document.xml / slide*.xml)
                  └─ TablesExtractor (markdown & matrix tables)
            │
            ▼
      ParsedDocument
            │
            ▼
     DocumentChunker (Hierarchical Chunking)
            │
            ▼
     DocumentChunk[] (with citations doc://<id>/page/<n>#<section>)
            │
            ▼
   DocumentMemoryBridge
            │
            ▼
   NEXUS MemoryService (LONG_TERM semantic memory with provenance)
```

## 3. Native Agent Tools

| Tool                        | Domain                            | Risk Level | Description                                                                    |
| --------------------------- | --------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `document.parse`            | `filesystem.read`                 | `SAFE`     | Extracts text, metadata, pages, and sections                                   |
| `document.extract_tables`   | `filesystem.read`                 | `SAFE`     | Extracts all structured tables (headers and rows)                              |
| `document.ingest_to_memory` | `filesystem.read`, `memory.write` | `MEDIUM`   | Chunks document and injects indexed fragments with citations into NEXUS memory |
