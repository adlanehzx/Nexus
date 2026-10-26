import { describe, expect, it } from "vitest";
import {
  contactEmailHash,
  contentHash,
  normalizeForComparison,
  opportunityFingerprint,
  submissionIdempotencyKey,
  submissionPayloadHash,
} from "../src/fingerprint.js";

const base = {
  kind: "phd" as const,
  title: "PhD in distributed systems",
  organization: "Université Example",
  location: "Lyon",
  externalRef: null,
};

describe("normalizeForComparison", () => {
  it("folds case, accents, punctuation and whitespace", () => {
    expect(normalizeForComparison("Université  de  Lyon—1")).toBe("universite de lyon 1");
  });

  it("does not stem, so two different posts stay different", () => {
    expect(normalizeForComparison("cryptography")).not.toBe(
      normalizeForComparison("cryptographic"),
    );
  });
});

describe("opportunityFingerprint", () => {
  it("merges the same posting written with different accents, case and punctuation", () => {
    expect(
      opportunityFingerprint({
        ...base,
        organization: "universite example",
        title: "PhD in Distributed Systems!",
      }),
    ).toBe(opportunityFingerprint(base));
  });

  it("keeps two different posts at one institution apart", () => {
    expect(opportunityFingerprint({ ...base, title: "PhD in cryptography" })).not.toBe(
      opportunityFingerprint(base),
    );
  });

  it("separates the same title at a different organisation", () => {
    expect(opportunityFingerprint({ ...base, organization: "Other Institute" })).not.toBe(
      opportunityFingerprint(base),
    );
  });

  it("separates the same posting advertised for a different kind", () => {
    expect(opportunityFingerprint({ ...base, kind: "permanent_job" })).not.toBe(
      opportunityFingerprint(base),
    );
  });

  it("separates two posts that differ only by location", () => {
    expect(opportunityFingerprint({ ...base, location: "Paris" })).not.toBe(
      opportunityFingerprint(base),
    );
  });

  it("folds a source identifier in rather than letting it decide identity alone", () => {
    const withRef = opportunityFingerprint({ ...base, externalRef: "REF-1" });
    expect(withRef).not.toBe(opportunityFingerprint(base));
    // Two different posts sharing a source identifier must not collide.
    expect(withRef).not.toBe(
      opportunityFingerprint({ ...base, title: "PhD in cryptography", externalRef: "REF-1" }),
    );
  });

  it("is a stable 64-character hex digest", () => {
    expect(opportunityFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(opportunityFingerprint(base)).toBe(opportunityFingerprint(base));
  });
});

describe("submissionPayloadHash", () => {
  const payload = {
    opportunityFingerprint: opportunityFingerprint(base),
    documentHashes: [contentHash("cover letter"), contentHash("cv")],
    contactEmailHash: contactEmailHash("supervisor@example.test"),
  };

  it("ignores the order documents were drafted in", () => {
    expect(
      submissionPayloadHash({ ...payload, documentHashes: [...payload.documentHashes].reverse() }),
    ).toBe(submissionPayloadHash(payload));
  });

  it("changes when any document body changes", () => {
    expect(
      submissionPayloadHash({
        ...payload,
        documentHashes: [contentHash("cover letter, revised"), contentHash("cv")],
      }),
    ).not.toBe(submissionPayloadHash(payload));
  });

  it("changes when the recipient changes", () => {
    expect(
      submissionPayloadHash({
        ...payload,
        contactEmailHash: contactEmailHash("other@example.test"),
      }),
    ).not.toBe(submissionPayloadHash(payload));
  });

  it("changes when a document is removed", () => {
    expect(submissionPayloadHash({ ...payload, documentHashes: [contentHash("cv")] })).not.toBe(
      submissionPayloadHash(payload),
    );
  });
});

describe("submissionIdempotencyKey", () => {
  const input = {
    applicationId: "44444444-4444-7444-8444-444444444444",
    payloadHash: contentHash("payload"),
    confirmationId: "55555555-5555-7555-8555-555555555555",
  };

  it("is derived, so a retry after a crash reproduces the same key", () => {
    expect(submissionIdempotencyKey(input)).toBe(submissionIdempotencyKey(input));
  });

  it("differs for a second approval of an identical payload", () => {
    expect(
      submissionIdempotencyKey({
        ...input,
        confirmationId: "66666666-6666-7666-8666-666666666666",
      }),
    ).not.toBe(submissionIdempotencyKey(input));
  });

  it("differs when the payload changed under the same approval", () => {
    expect(
      submissionIdempotencyKey({ ...input, payloadHash: contentHash("payload, edited") }),
    ).not.toBe(submissionIdempotencyKey(input));
  });
});

describe("contactEmailHash", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(contactEmailHash("  Supervisor@Example.Test ")).toBe(
      contactEmailHash("supervisor@example.test"),
    );
  });

  it("does not carry the address it stands for", () => {
    expect(contactEmailHash("supervisor@example.test")).not.toContain("example");
  });
});
