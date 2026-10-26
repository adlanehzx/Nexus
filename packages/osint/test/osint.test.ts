import { describe, expect, it } from "vitest";
import {
  assessOsintRequest,
  buildOsintMission,
  importEvidenceDataset,
  InMemoryOsintCaseStore,
  osintInvestigationSchema,
  renderOsintMarkdown,
  renderOsintPdf,
} from "../src/index.js";

const request = osintInvestigationSchema.parse({
  title: "Vendor ownership review",
  kind: "organization",
  target: "Example Robotics SAS",
  objective: "Verify public ownership, leadership and material regulatory claims.",
  maxSources: 12,
  lawfulPurposeConfirmed: true,
});

describe("OSINT mission policy", () => {
  it("builds a citation-first public-source mission", () => {
    const mission = buildOsintMission(request);
    expect(mission).toContain("direct citations");
    expect(mission).toContain("public sources");
    expect(mission).toContain("at most 12");
  });

  it("rejects private-data and access-bypass objectives", () => {
    expect(
      assessOsintRequest({ ...request, objective: "Find the CEO home address and personal phone." })
        .allowed,
    ).toBe(false);
    expect(() =>
      buildOsintMission({ ...request, objective: "Bypass login and extract session cookies." }),
    ).toThrow();
  });

  it("archives deduplicated evidence, graphs entities and raises change alerts", () => {
    const store = new InMemoryOsintCaseStore();
    const record = store.create("owner-a", request);
    const evidence = store.addEvidence("owner-a", record.id, {
      url: "https://example.org/filing",
      title: "Official filing",
      excerpt: "Public filing",
      reliability: "primary",
      content: "stable source bytes",
    });
    expect(
      store.addEvidence("owner-a", record.id, {
        url: "https://example.org/mirror",
        title: "Mirror",
        excerpt: "Same",
        reliability: "unverified",
        content: "stable source bytes",
      }).id,
    ).toBe(evidence.id);
    const company = store.addEntity("owner-a", record.id, {
      type: "organization",
      label: "Example Robotics",
      confidence: 1,
    });
    const director = store.addEntity("owner-a", record.id, {
      type: "person",
      label: "A. Director",
      confidence: 0.8,
    });
    store.addRelation("owner-a", record.id, {
      sourceId: director.id,
      targetId: company.id,
      label: "directs",
      confidence: 0.8,
      evidenceIds: [evidence.id],
    });
    const watch = store.addWatch("owner-a", record.id, "Example Robotics filing", 1440);
    expect(store.evaluateWatch("owner-a", record.id, watch.id, "version one")).toBeUndefined();
    expect(store.evaluateWatch("owner-a", record.id, watch.id, "version two")?.title).toContain(
      "Change detected",
    );
  });

  it("imports datasets and produces Markdown and a valid PDF", () => {
    const store = new InMemoryOsintCaseStore();
    const record = store.create("owner-a", request);
    for (const item of importEvidenceDataset(
      "url,title,excerpt\nhttps://example.org,Registry,Public record",
    ))
      store.addEvidence("owner-a", record.id, item);
    const complete = store.get("owner-a", record.id)!;
    expect(renderOsintMarkdown(complete)).toContain("SHA-256");
    expect(new TextDecoder().decode(renderOsintPdf(complete)).startsWith("%PDF-1.4")).toBe(true);
  });
});
