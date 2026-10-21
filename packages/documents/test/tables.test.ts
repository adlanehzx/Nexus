import { describe, expect, it } from "vitest";
import { extractTablesFromText, parseMarkdownTable, tableToMarkdown } from "../src/tables.js";

describe("table extraction and manipulation", () => {
  it("parses regular Markdown table", () => {
    const raw = `
| Product | Price | Stock |
| --- | --- | --- |
| NEXUS Hub | 150 USD | 12 |
| NEXUS Sensor | 45 USD | 30 |
    `.trim();

    const table = parseMarkdownTable(raw);
    expect(table).not.toBeNull();
    expect(table?.headers).toEqual(["Product", "Price", "Stock"]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[0]).toEqual(["NEXUS Hub", "150 USD", "12"]);
    expect(table?.rows[1]).toEqual(["NEXUS Sensor", "45 USD", "30"]);
  });

  it("generates aligned Markdown from cells", () => {
    const md = tableToMarkdown(["A", "B"], [["1", "2"]]);
    expect(md).toContain("| A | B |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("extracts all tables embedded in text", () => {
    const doc = `
# Financial report

Here are the first quarter sales:

| Month | Revenue |
| --- | --- |
| January | 10000 |
| February | 12000 |

And here is the channel breakdown:

| Channel | Share |
| --- | --- |
| Web | 80% |
| Partners | 20% |

End of report.
    `;

    const tables = extractTablesFromText(doc, 3);
    expect(tables).toHaveLength(2);
    expect(tables[0]?.headers).toEqual(["Month", "Revenue"]);
    expect(tables[0]?.pageNumber).toBe(3);
    expect(tables[1]?.headers).toEqual(["Channel", "Share"]);
  });
});
