import { describe, expect, it } from "vitest";
import { REDACTED } from "@nexus/shared";
import {
  FORBIDDEN_AUDIT_FIELDS,
  contactView,
  documentSummaryView,
  documentView,
  maskEmail,
  opportunityView,
  redactForAudit,
} from "../src/views.js";
import type { Contact, DocumentVariant } from "../src/model.js";
import { contentHash } from "../src/fingerprint.js";
import { NOW, makeOpportunity } from "./fixtures.js";

const contact: Contact = {
  id: "77777777-7777-7777-8777-777777777777",
  userId: "22222222-2222-7222-8222-222222222222",
  applicationId: null,
  opportunityId: null,
  displayName: "Hiring Lead",
  role: "Head of platform",
  organization: "Example Storage Cooperative",
  email: "hiring@careers.example.test",
  notes: "Met at a conference.",
  source: "referral",
  createdAt: NOW,
  updatedAt: NOW,
};

const variant: DocumentVariant = {
  id: "88888888-8888-7888-8888-888888888888",
  userId: contact.userId,
  applicationId: "99999999-9999-7999-8999-999999999999",
  kind: "cover_letter",
  revision: 2,
  parentVariantId: "88888888-8888-7888-8888-888888888887",
  profileVersion: 3,
  contentHash: contentHash("a".repeat(600)),
  body: "a".repeat(600),
  createdAt: NOW,
};

describe("maskEmail", () => {
  it("keeps the first character and the whole domain", () => {
    expect(maskEmail("hiring@careers.example.test")).toBe("h***@careers.example.test");
  });

  it("refuses to half-mask something that is not an address", () => {
    expect(maskEmail("not-an-address")).toBe("[redacted]");
    expect(maskEmail("@example.test")).toBe("[redacted]");
  });
});

describe("document views", () => {
  it("bounds the body on a list view and keeps the hash", () => {
    const summary = documentSummaryView(variant);
    expect(summary.preview.length).toBeLessThan(variant.body.length);
    expect(summary.preview).toContain("truncated");
    expect(summary.contentHash).toBe(variant.contentHash);
    expect(summary).not.toHaveProperty("body");
  });

  it("returns the body only on the single-document view", () => {
    expect(documentView(variant).body).toBe(variant.body);
  });

  it("carries the lineage, so a stale draft can be recognised", () => {
    const summary = documentSummaryView(variant);
    expect(summary.revision).toBe(2);
    expect(summary.parentVariantId).toBe(variant.parentVariantId);
    expect(summary.profileVersion).toBe(3);
  });
});

describe("contact view", () => {
  it("returns the address in full to the owner who typed it", () => {
    expect(contactView(contact).email).toBe("hiring@careers.example.test");
  });

  it("never carries the owning user identifier", () => {
    expect(contactView(contact)).not.toHaveProperty("userId");
  });
});

describe("opportunity view", () => {
  it("states that the content is untrusted and where it came from", () => {
    const view = opportunityView(makeOpportunity());
    expect(view.untrustedContent).toBe(true);
    expect(view.provenance[0]?.evidence.length).toBeGreaterThan(0);
    expect(view.provenance[0]?.observedAt).toBe(NOW.toISOString());
  });

  it("serialises every date as an ISO string", () => {
    const view = opportunityView(makeOpportunity());
    expect(view.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof view.closesAt).toBe("string");
  });

  it("never carries the owning user identifier", () => {
    expect(opportunityView(makeOpportunity())).not.toHaveProperty("userId");
  });
});

describe("redactForAudit", () => {
  it("drops every field named on the forbidden list", () => {
    const audited = redactForAudit({
      applicationId: "app-1",
      email: "hiring@careers.example.test",
      body: "the whole cover letter",
      draft: "the whole follow-up",
      description: "the whole listing",
      token: "nsg_secret",
    });

    expect(audited).toEqual({ applicationId: "app-1" });
    for (const field of FORBIDDEN_AUDIT_FIELDS) expect(audited).not.toHaveProperty(field);
  });

  it("still catches a secret that arrived under an innocent name", () => {
    const audited = redactForAudit({ value: "sk-abcdefghijklmnopqrstuvwxyz012345" });
    expect(audited.value).toBe(REDACTED);
  });

  it("bounds every string, so the audited content cannot inflate the audit trail", () => {
    const audited = redactForAudit({ note: "x".repeat(5_000) });
    expect(String(audited.note).length).toBeLessThan(300);
  });

  it("leaves identifiers, scores and states intact", () => {
    const audited = redactForAudit({
      applicationId: "app-1",
      score: 87,
      state: "approved",
      excluded: false,
    });
    expect(audited).toEqual({
      applicationId: "app-1",
      score: 87,
      state: "approved",
      excluded: false,
    });
  });

  it("bounds recursion rather than following a deep or cyclic structure", () => {
    const cyclic: Record<string, unknown> = { applicationId: "app-1" };
    cyclic.self = cyclic;
    expect(() => redactForAudit(cyclic)).not.toThrow();
  });
});
