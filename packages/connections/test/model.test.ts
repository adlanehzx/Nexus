import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CONNECTION_FIELDS,
  connectionSchema,
  connectionStateSchema,
} from "../src/model.js";

/** A connection that is valid, used as the base for every rejection test. */
function validConnection() {
  return {
    id: "acp:codex",
    providerId: "codex",
    kind: "acp" as const,
    displayName: "Codex",
    state: "detected" as const,
    version: "1.4.2",
    executablePath: "/usr/local/bin/codex",
    capabilities: [],
    availableActions: ["detect" as const],
    platform: "linux" as const,
    lastCheckedAt: "2026-10-22T00:00:00.000Z",
    lastSuccessAt: null,
    errorCategory: null,
    userMessage: null,
    requiresHumanAction: false,
    adapter: { available: true, provenance: "official" as const, provenanceEvidence: "scope" },
  };
}

describe("connection model", () => {
  it("accepts a well-formed connection", () => {
    expect(() => connectionSchema.parse(validConnection())).not.toThrow();
  });

  it.each(FORBIDDEN_CONNECTION_FIELDS)("refuses a connection carrying %s", (field) => {
    // The list comes from the module, not from this test: one copy of a
    // security rule cannot drift away from the other.
    const withSecret = { ...validConnection(), [field]: "whatever" };

    expect(() => connectionSchema.parse(withSecret)).toThrow();
  });

  it("refuses any unknown field, not only the listed ones", () => {
    // The forbidden list documents intent; `strict` is what enforces it. A
    // field nobody thought to forbid is refused all the same.
    expect(() =>
      connectionSchema.parse({ ...validConnection(), somethingNobodyForbade: "x" }),
    ).toThrow();
  });

  it("refuses a bearer token hidden in the nested adapter object", () => {
    expect(() =>
      connectionSchema.parse({
        ...validConnection(),
        adapter: { ...validConnection().adapter, authorization: "Bearer x" },
      }),
    ).toThrow();
  });

  it("requires evidence for a provenance claim", () => {
    const connection = validConnection();
    expect(() =>
      connectionSchema.parse({
        ...connection,
        adapter: { available: true, provenance: "official", provenanceEvidence: "" },
      }),
    ).toThrow();
  });

  it("refuses an id that is not a stable identifier", () => {
    for (const id of ["Acp:Codex", "acp codex", "../etc/passwd", ""]) {
      expect(() => connectionSchema.parse({ ...validConnection(), id })).toThrow();
    }
  });

  it("keeps the state vocabulary closed", () => {
    expect(connectionStateSchema.options).toHaveLength(10);
    expect(() => connectionStateSchema.parse("working")).toThrow();
  });
});
