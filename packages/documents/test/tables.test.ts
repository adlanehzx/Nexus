import { describe, expect, it } from "vitest";
import { extractTablesFromText, parseMarkdownTable, tableToMarkdown } from "../src/tables.js";

describe("Extraction et manipulation de tableaux", () => {
  it("analyse un tableau Markdown régulier", () => {
    const raw = `
| Produit | Prix | Stock |
| --- | --- | --- |
| NEXUS Hub | 150€ | 12 |
| NEXUS Sensor | 45€ | 30 |
    `.trim();

    const table = parseMarkdownTable(raw);
    expect(table).not.toBeNull();
    expect(table?.headers).toEqual(["Produit", "Prix", "Stock"]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[0]).toEqual(["NEXUS Hub", "150€", "12"]);
    expect(table?.rows[1]).toEqual(["NEXUS Sensor", "45€", "30"]);
  });

  it("génère du Markdown aligné depuis des cellules", () => {
    const md = tableToMarkdown(["A", "B"], [["1", "2"]]);
    expect(md).toContain("| A | B |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("extrait tous les tableaux imbriqués dans un texte", () => {
    const doc = `
# Rapport financier

Voici les ventes du premier trimestre :

| Mois | CA (€) |
| --- | --- |
| Janvier | 10000 |
| Février | 12000 |

Et voici la répartition par canal :

| Canal | Part |
| --- | --- |
| Web | 80% |
| Partenaires | 20% |

Fin du rapport.
    `;

    const tables = extractTablesFromText(doc, 3);
    expect(tables).toHaveLength(2);
    expect(tables[0]?.headers).toEqual(["Mois", "CA (€)"]);
    expect(tables[0]?.pageNumber).toBe(3);
    expect(tables[1]?.headers).toEqual(["Canal", "Part"]);
  });
});
