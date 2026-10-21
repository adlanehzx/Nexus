import { type DocumentTable } from "./types.js";

/**
 * Converts headers and rows into a well-formatted Markdown table.
 */
export function tableToMarkdown(headers: string[], rows: string[][]): string {
  if (headers.length === 0 && rows.length === 0) return "";

  const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
  const padHeaders = [...headers];
  while (padHeaders.length < colCount) padHeaders.push("");

  const headerLine = `| ${padHeaders.join(" | ")} |`;
  const separatorLine = `| ${padHeaders.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => {
    const padRow = [...row];
    while (padRow.length < colCount) padRow.push("");
    return `| ${padRow.join(" | ")} |`;
  });

  return [headerLine, separatorLine, ...rowLines].join("\n");
}

/**
 * Parses and extracts a Markdown table from a textual block.
 */
export function parseMarkdownTable(
  block: string,
  options?: { caption?: string | undefined; pageNumber?: number | undefined },
): DocumentTable | null {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"));

  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

  const headers = parseRow(lines[0] ?? "");
  const separator = lines[1] ?? "";
  if (!separator.includes("-")) return null;

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = parseRow(lines[i] ?? "");
    if (row.length > 0) rows.push(row);
  }

  const markdown = tableToMarkdown(headers, rows);

  return {
    headers,
    rows,
    ...(options?.caption !== undefined ? { caption: options.caption } : {}),
    ...(options?.pageNumber !== undefined ? { pageNumber: options.pageNumber } : {}),
    markdown,
  };
}

/**
 * Detects and extracts all Markdown tables present in free text.
 */
export function extractTablesFromText(text: string, pageNumber?: number): DocumentTable[] {
  const tables: DocumentTable[] = [];
  const lines = text.split("\n");
  let currentTableLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      currentTableLines.push(trimmed);
    } else {
      if (currentTableLines.length >= 2) {
        const table = parseMarkdownTable(currentTableLines.join("\n"), {
          ...(pageNumber !== undefined ? { pageNumber } : {}),
        });
        if (table) tables.push(table);
      }
      currentTableLines = [];
    }
  }

  if (currentTableLines.length >= 2) {
    const table = parseMarkdownTable(currentTableLines.join("\n"), {
      ...(pageNumber !== undefined ? { pageNumber } : {}),
    });
    if (table) tables.push(table);
  }

  return tables;
}
