import { describe, expect, it } from "vitest";
import {
  assessOsintRequest,
  buildOsintMission,
  createOsintTools,
  parseSherlockOutput,
  sherlockUsernameSchema,
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

  it("hydrates a durable snapshot without weakening owner isolation", () => {
    const initial = new InMemoryOsintCaseStore();
    const record = initial.create("owner-a", request);
    initial.addWatch("owner-a", record.id, "https://example.org/news", 60);
    const restored = new InMemoryOsintCaseStore(initial.snapshot());
    expect(restored.get("owner-a", record.id)?.watches).toHaveLength(1);
    expect(restored.get("owner-b", record.id)).toBeUndefined();
  });

  it("exposes owner-scoped native tools for collaborating agents", async () => {
    const store = new InMemoryOsintCaseStore();
    const record = store.create("owner-a", request);
    const tools = createOsintTools({
      get: (ownerId, caseId) => Promise.resolve(store.get(ownerId, caseId)),
      addEvidence: (ownerId, caseId, input) =>
        Promise.resolve(store.addEvidence(ownerId, caseId, input)),
      addEntity: (ownerId, caseId, input) =>
        Promise.resolve(store.addEntity(ownerId, caseId, input)),
      addRelation: (ownerId, caseId, input) =>
        Promise.resolve(store.addRelation(ownerId, caseId, input)),
    });
    const inspect = tools.find((tool) => tool.name === "osint.case.inspect")!;
    const context = {
      runId: "run-1",
      userId: "owner-b",
      conversationId: "conversation-1",
      correlationId: "correlation-1",
      signal: new AbortController().signal,
      idempotencyKey: "idempotency-1",
      attempt: 1,
      onProgress: () => undefined,
    };
    await expect(inspect.execute({ caseId: record.id } as never, context)).rejects.toThrow(
      /not found/i,
    );
    await expect(
      inspect.execute({ caseId: record.id } as never, { ...context, userId: "owner-a" }),
    ).resolves.toMatchObject({ id: record.id });
  });

  it("validates usernames and parses only positive Sherlock findings", () => {
    expect(sherlockUsernameSchema.parse("example.user-1")).toBe("example.user-1");
    expect(() => sherlockUsernameSchema.parse("name; rm -rf /")).toThrow();
    expect(
      parseSherlockOutput(
        [
          "[*] Checking username example.user-1 on:",
          "[+] GitHub: https://github.com/example.user-1",
          "[-] Reddit: Not Found!",
          "[+] GitHub: https://github.com/example.user-1",
          "[+] Mastodon: https://mastodon.social/@example.user-1",
        ].join("\n"),
      ),
    ).toEqual([
      { site: "GitHub", profileUrl: "https://github.com/example.user-1" },
      { site: "Mastodon", profileUrl: "https://mastodon.social/@example.user-1" },
    ]);
  });
});
