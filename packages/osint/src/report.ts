import type { OsintCaseRecord } from "./case.js";

export function renderOsintMarkdown(record: OsintCaseRecord): string {
  const evidence = record.evidence
    .map(
      (item, index) =>
        `${index + 1}. [${item.title}](${item.url}) — ${item.reliability} — SHA-256 \`${item.contentHash}\`\n   ${item.excerpt}`,
    )
    .join("\n");
  const entities = record.entities
    .map((item) => `- ${item.label} (${item.type}, ${Math.round(item.confidence * 100)}%)`)
    .join("\n");
  return `# ${record.investigation.title}\n\n**Target:** ${record.investigation.target}\n\n## Objective\n\n${record.investigation.objective}\n\n## Entities\n\n${entities || "No entities recorded."}\n\n## Evidence\n\n${evidence || "No evidence recorded."}\n`;
}

/** Minimal valid, text-only PDF for portable evidence handoff without a runtime dependency. */
export function renderOsintPdf(record: OsintCaseRecord): Uint8Array {
  const lines =
    renderOsintMarkdown(record)
      .replaceAll(/[\r\n]+/g, " ")
      .match(/.{1,90}(?:\s|$)/g)
      ?.slice(0, 45) ?? [];
  const escape = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 10 Tf 50 790 Td 13 TL ${lines.map((line, index) => `${index === 0 ? "" : "T* "}(${escape(line.trim())}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

export function importEvidenceDataset(input: string): {
  url: string;
  title: string;
  excerpt: string;
  reliability: "primary" | "corroborated" | "unverified";
  content: string;
}[] {
  const trimmed = input.trim();
  const text = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value : fallback;
  if (trimmed.startsWith("["))
    return (JSON.parse(trimmed) as unknown[]).map((value) => {
      const item = value as Record<string, unknown>;
      return {
        url: text(item.url),
        title: text(item.title, "Imported evidence"),
        excerpt: text(item.excerpt),
        reliability: "unverified" as const,
        content: JSON.stringify(item),
      };
    });
  const [header, ...rows] = trimmed.split(/\r?\n/);
  const columns = header?.split(",").map((item) => item.trim()) ?? [];
  return rows.filter(Boolean).map((row) => {
    const values = row.split(",");
    const item = Object.fromEntries(
      columns.map((column, index) => [column, values[index]?.trim() ?? ""]),
    );
    return {
      url: item.url ?? "",
      title: item.title ?? "Imported evidence",
      excerpt: item.excerpt ?? "",
      reliability: "unverified" as const,
      content: row,
    };
  });
}
