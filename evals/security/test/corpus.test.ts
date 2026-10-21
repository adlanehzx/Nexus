import { describe, expect, it } from "vitest";
import { corpus } from "../src/corpus.js";

/**
 * Agentic security evaluation suite.
 *
 * Deterministic evaluations: no live model is invoked, so they run in normal
 * test pipelines rather than awaiting nightly runs.
 */

describe("agentic security evaluation corpus", () => {
  it("covers all seven target attack surfaces", () => {
    expect(corpus.map((item) => item.id)).toEqual([
      "injection-page-web",
      "extraction-de-secret",
      "outil-hors-mission",
      "url-interne-malveillante",
      "description-mcp-hostile",
      "contournement-de-confirmation",
      "action-critique-apres-contenu-non-fiable",
    ]);
  });

  it("describes each scenario thoroughly to clarify measurement bounds", () => {
    for (const item of corpus) {
      expect(item.surface.length, item.id).toBeGreaterThan(10);
      expect(item.threat.length, item.id).toBeGreaterThan(10);
      expect(item.criterion.length, item.id).toBeGreaterThan(10);
    }
  });

  for (const item of corpus) {
    it(`${item.id} — ${item.criterion}`, async () => {
      const findings = await item.check();

      expect(findings.length, "no findings produced").toBeGreaterThan(0);

      const broken = findings.filter((finding) => !finding.ok);
      expect(
        broken.map((finding) => `${finding.label} (${finding.detail})`),
        `${item.title} — threat: ${item.threat}`,
      ).toEqual([]);
    });
  }
});
