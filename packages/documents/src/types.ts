import { z } from "zod";

export const documentFormatSchema = z.enum(["pdf", "docx", "pptx", "md", "txt", "unknown"]);
export type DocumentFormat = z.infer<typeof documentFormatSchema>;

export interface DocumentTable {
  headers: string[];
  rows: string[][];
  caption?: string | undefined;
  pageNumber?: number | undefined;
  markdown: string;
}

export interface DocumentSection {
  title: string;
  level: number;
  pageNumber: number;
  content: string;
  tables: DocumentTable[];
}

export interface DocumentMetadata {
  title?: string | undefined;
  author?: string | undefined;
  pageCount: number;
  createdAt?: string | undefined;
  fileSizeBytes: number;
  sha256: string;
}

export interface ParsedDocument {
  id: string;
  filename: string;
  format: DocumentFormat;
  metadata: DocumentMetadata;
  sections: DocumentSection[];
  fullText: string;
  tables: DocumentTable[];
  parserUsed: "docling" | "local";
}

export interface DocumentChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  pageNumber: number;
  sectionTitle: string;
  sectionHierarchy: string[];
  content: string;
  citationUri: string;
  citationLabel: string;
  tables?: DocumentTable[] | undefined;
}
