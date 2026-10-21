import { describe, expect, it } from "vitest";
import { classify, safePreview } from "../src/sensitivity.js";
import { parseMemoryCommand } from "../src/commands.js";

/**
 * Sensitivity classification and explicit commands tests.
 *
 * Verifies the boundary: what can be retained, what requires confirmation,
 * and what is unconditionally prohibited.
 */

describe("prohibited content", () => {
  const secrets = [
    "My password is correcthorsebatterystaple",
    "Wifi password: Tr0ub4dor&3xy",
    "Ma cl\u00e9 API est sk-abcdefghijklmnopqrstuvwx",
    "password=hunter2hunter2",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "Ma phrase de r\u00e9cup\u00e9ration : witch collapse practice feed",
  ];

  for (const content of secrets) {
    it(`rejects: "${content.slice(0, 32)}…"`, () => {
      expect(classify(content).verdict).toBe("FORBIDDEN");
    });
  }

  it("rejects credit card number", () => {
    // 4539 1488 0343 6467 passes Luhn check.
    expect(classify("My card: 4539 1488 0343 6467").verdict).toBe("FORBIDDEN");
  });

  it("does not reject arbitrary long digit sequences", () => {
    expect(classify("Order number 1234567890123").verdict).toBe("ORDINARY");
  });

  it("explains refusal without reproducing secret content", () => {
    const verdict = classify("My password is Tr0ub4dor3xy");

    expect(verdict.explanation).toContain("password manager");
    expect(verdict.explanation).not.toContain("Tr0ub4dor3xy");
    expect(verdict.categories).toContain("mot-de-passe");
  });
});

describe("content requiring explicit consent", () => {
  const personal = [
    ["sante", "I was diagnosed with diabetes in 2019"],
    ["finance", "My IBAN is the joint account one"],
    ["identite", "My social security number is on the form"],
    ["adresse", "12 rue des Lilas"],
  ] as const;

  for (const [category, content] of personal) {
    it(`classifies "${category}" as personal`, () => {
      const verdict = classify(content);

      expect(verdict.verdict).toBe("PERSONAL");
      expect(verdict.categories).toContain(category);
    });
  }

  it("names categories without quoting sensitive content", () => {
    const verdict = classify("I was diagnosed with diabetes");

    expect(verdict.explanation).not.toContain("diabetes");
    expect(verdict.explanation).toContain("sante");
  });
});

describe("ordinary content", () => {
  const ordinary = [
    "Alex prefers trains over planes",
    "Team sync every Tuesday at 10 AM",
    "NEXUS repo uses pnpm and Turborepo",
    "Always reply in English",
  ];

  for (const content of ordinary) {
    it(`accepts: "${content.slice(0, 30)}…"`, () => {
      expect(classify(content).verdict).toBe("ORDINARY");
    });
  }
});

describe("safe preview", () => {
  it("masks secret in preview", () => {
    const preview = safePreview("My key is sk-abcdefghijklmnopqrstuvwx and more", 200);

    expect(preview).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(preview).toContain("[REDACTED]");
  });

  it("bounds output length", () => {
    expect(safePreview("a".repeat(500), 20)).toHaveLength(21);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("remember command", () => {
  const forms = [
    "Retiens que I prefer trains",
    "retiens : I prefer trains",
    "Souviens-toi que I prefer trains",
    "Rappelle-toi que I prefer trains",
    "M\u00e9morise que I prefer trains",
    "Note que I prefer trains",
    "Remember that I prefer trains",
    "Remember this: I prefer trains",
  ];

  for (const form of forms) {
    it(`recognizes "${form.slice(0, 26)}…"`, () => {
      const command = parseMemoryCommand(form);

      expect(command?.kind).toBe("remember");
      expect(command).toMatchObject({ content: "I prefer trains" });
    });
  }

  it("removes trailing punctuation", () => {
    expect(parseMemoryCommand("Remember that X.")).toMatchObject({ content: "X" });
  });
});

describe("forget command", () => {
  it("recognizes a target", () => {
    expect(parseMemoryCommand("Forget that I live in Lyon")).toEqual({
      kind: "forget",
      target: "I live in Lyon",
      all: false,
    });
  });

  it("distinguishes total purge", () => {
    for (const form of ["Oublie tout", "Efface toute ta m\u00e9moire", "Forget everything"]) {
      expect(parseMemoryCommand(form)).toEqual({ kind: "forget", target: "", all: true });
    }
  });
});

describe("non-command messages", () => {
  const messages = [
    "I remember that the train was late",
    "Can you remind me of my appointments?",
    "I forgot my umbrella on the train",
    "I should write that down somewhere",
    "What is the weather?",
    "",
    "   ",
  ];

  for (const message of messages) {
    it(`ignores: "${message.trim().slice(0, 34) || "(empty)"}"`, () => {
      expect(parseMemoryCommand(message)).toBeUndefined();
    });
  }
});
