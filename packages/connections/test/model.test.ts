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
    authStatus: "unknown" as const,
    errorCategory: null,
    userMessage: null,
    requiresHumanAction: false,
    adapter: {
      availability: "unknown" as const,
      provenance: "unknown" as const,
      provenanceEvidence: "no vendor publication evidence available",
    },
  };
}

describe("connection model", () => {
  it("accepts a well-formed connection", () => {
    expect(() => connectionSchema.parse(validConnection())).not.toThrow();
  });

  it("accepts a connection with structured, secret-free authGuide", () => {
    const withAuth = {
      ...validConnection(),
      authGuide: {
        kind: "cli_command" as const,
        command: "codex login",
        instructions: "Run codex login to authenticate",
        url: "https://example.com/docs",
      },
    };
    expect(() => connectionSchema.parse(withAuth)).not.toThrow();
  });

  it("refuses secrets or extra fields smuggled in authGuide", () => {
    const withSecret = {
      ...validConnection(),
      authGuide: {
        kind: "cli_command" as const,
        command: "codex login",
        instructions: "Run login",
        url: null,
        token: "secret-token",
      },
    };
    expect(() => connectionSchema.parse(withSecret)).toThrow();
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
        adapter: { availability: "unknown", provenance: "unknown", provenanceEvidence: "" },
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

describe("adapter availability", () => {
  it.each(["available", "missing", "unknown"])("accepts %s", (availability) => {
    const connection = validConnection();
    expect(() =>
      connectionSchema.parse({ ...connection, adapter: { ...connection.adapter, availability } }),
    ).not.toThrow();
  });

  it("refuses a boolean where the three-state value belongs", () => {
    // The shape this replaced. A boolean cannot say "I have not looked", so it
    // forces a guess, and the guess made was "the CLI is here, so the adapter
    // must be".
    const connection = validConnection();
    expect(() =>
      connectionSchema.parse({
        ...connection,
        adapter: { available: true, provenance: "unknown", provenanceEvidence: "x" },
      }),
    ).toThrow();
  });

  it("refuses an availability value nobody declared", () => {
    const connection = validConnection();
    expect(() =>
      connectionSchema.parse({
        ...connection,
        adapter: { ...connection.adapter, availability: "probably" },
      }),
    ).toThrow();
  });
});

describe("authentication status", () => {
  it.each(["authenticated", "unauthenticated", "expired", "unknown"])(
    "accepts %s",
    (authStatus) => {
      expect(() => connectionSchema.parse({ ...validConnection(), authStatus })).not.toThrow();
    },
  );

  it("refuses a value outside the shared vocabulary", () => {
    // The four values match authStatusSchema in the API's provider-accounts
    // service, so the two surfaces cannot disagree about what "expired" means.
    expect(() =>
      connectionSchema.parse({ ...validConnection(), authStatus: "signed_in" }),
    ).toThrow();
  });

  it("requires the field rather than defaulting it", () => {
    const { authStatus: _dropped, ...withoutStatus } = validConnection();

    // A default would let a caller forget it and get "unknown" for free, which
    // reads the same as a deliberate "we did not look" and hides the omission.
    expect(() => connectionSchema.parse(withoutStatus)).toThrow();
  });

  it("is a separate field from the state", () => {
    // Related, not identical: these two pairings are both legitimate and a
    // single value could not express either.
    expect(() =>
      connectionSchema.parse({
        ...validConnection(),
        state: "authentication_required",
        authStatus: "unknown",
      }),
    ).not.toThrow();
    expect(() =>
      connectionSchema.parse({ ...validConnection(), state: "detected", authStatus: "unknown" }),
    ).not.toThrow();
  });
});
