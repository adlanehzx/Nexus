import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const investigation = {
  title: "Public supplier review",
  kind: "organization",
  target: "Example Industries",
  objective: "Verify ownership and public corporate records before procurement.",
  maxSources: 12,
  lawfulPurposeConfirmed: true,
} as const;

describe("OSINT API", () => {
  let harness: ApiHarness;
  let owner: Account;
  let outsider: Account;

  beforeEach(async () => {
    harness = await makeApi();
    owner = await createAccount(harness, "osint-owner@example.test");
    outsider = await createAccount(harness, "osint-outsider@example.test");
  });

  afterEach(async () => harness.close());

  it("persists an evidence-led case and isolates it by owner", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/osint/cases",
      headers: owner.authorization,
      payload: investigation,
    });
    expect(created.statusCode).toBe(200);
    const caseId = created.json<{ data: { id: string } }>().data.id;

    const imported = await harness.app.inject({
      method: "POST",
      url: `/api/v1/osint/cases/${caseId}/import`,
      headers: owner.authorization,
      payload: {
        dataset: "url,title,excerpt\nhttps://example.org/registry,Official registry,Public filing",
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json<{ data: { evidence: unknown[] } }>().data.evidence).toHaveLength(1);

    const hidden = await harness.app.inject({
      method: "GET",
      url: `/api/v1/osint/cases/${caseId}`,
      headers: outsider.authorization,
    });
    expect(hidden.statusCode).toBe(404);

    const report = await harness.app.inject({
      method: "GET",
      url: `/api/v1/osint/cases/${caseId}/report?format=pdf`,
      headers: owner.authorization,
    });
    expect(report.statusCode).toBe(200);
    const pdf = Buffer.from(report.json<{ data: { content: string } }>().data.content, "base64");
    expect(pdf.toString("utf8", 0, 8)).toBe("%PDF-1.4");
  });

  it("requires authentication and explicit lawful-purpose confirmation", async () => {
    const anonymous = await harness.app.inject({ method: "GET", url: "/api/v1/osint/cases" });
    expect(anonymous.statusCode).toBe(401);
    const rejected = await harness.app.inject({
      method: "POST",
      url: "/api/v1/osint/cases",
      headers: owner.authorization,
      payload: { ...investigation, lawfulPurposeConfirmed: false },
    });
    expect(rejected.statusCode).toBe(400);
  });
});
