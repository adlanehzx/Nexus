import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";
import {
  MemoryService,
  SensitiveMemoryNeedsConsentError,
  SensitiveMemoryRefusedError,
} from "../src/service.js";

/**
 * Memory service policy tests.
 *
 * Verifies the silence rule: nothing sensitive is stored silently.
 */

const USER_ID = "user-example";
const OTHER_USER = "user-other";

interface Audit {
  action: string;
  userId: string;
  recordId?: string;
  categories?: readonly string[];
}

function makeService() {
  const audit: Audit[] = [];
  const provider = new InMemoryMemoryProvider({
    now: () => new Date("2026-09-03T10:00:00.000Z"),
  });

  return {
    provider,
    audit,
    service: new MemoryService({
      provider,
      onAudit: (event) => audit.push(event),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storing memories
// ─────────────────────────────────────────────────────────────────────────────

describe("remember", () => {
  it("stores ordinary information", async () => {
    const { service } = makeService();

    const record = await service.remember({
      userId: USER_ID,
      content: "Alex prefers the train",
    });

    expect(record.content).toBe("Alex prefers the train");
    expect(record.sensitivity).toBe("ORDINARY");
  });

  it("rejects prohibited secrets regardless of caller", async () => {
    const { service, provider } = makeService();

    await expect(
      service.remember({ userId: USER_ID, content: "Mon mot de passe est Tr0ub4dor3xy" }),
    ).rejects.toThrow(SensitiveMemoryRefusedError);

    expect(provider.size).toBe(0);
  });

  it("refusal does not write secret content to audit log", async () => {
    const { service, audit } = makeService();

    await service
      .remember({ userId: USER_ID, content: "Mon mot de passe est Tr0ub4dor3xy" })
      .catch(() => undefined);

    const refusal = audit.find((event) => event.action === "refuse");
    expect(refusal?.categories).toContain("mot-de-passe");
    expect(JSON.stringify(audit)).not.toContain("Tr0ub4dor3xy");
  });

  it("requires consent for personal information", async () => {
    const { service, provider } = makeService();

    await expect(
      service.remember({ userId: USER_ID, content: "J'ai été diagnostiqué diabétique" }),
    ).rejects.toThrow(SensitiveMemoryNeedsConsentError);

    expect(provider.size).toBe(0);
  });

  it("stores personal information once consent is provided", async () => {
    const { service } = makeService();

    const record = await service.remember({
      userId: USER_ID,
      content: "J'ai été diagnostiqué diabétique",
      acknowledgedSensitive: true,
    });

    expect(record.sensitivity).toBe("PERSONAL");
    expect(record.sensitiveCategories).toContain("sante");
  });

  it("rejects empty content", async () => {
    const { service } = makeService();
    await expect(service.remember({ userId: USER_ID, content: "   " })).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Updating memories
// ─────────────────────────────────────────────────────────────────────────────

describe("update", () => {
  it("re-classifies revised content", async () => {
    const { service } = makeService();
    const record = await service.remember({ userId: USER_ID, content: "An ordinary note" });

    await expect(
      service.update({
        userId: USER_ID,
        id: record.id,
        content: "Mon mot de passe est Tr0ub4dor3xy",
      }),
    ).rejects.toThrow(SensitiveMemoryRefusedError);
  });

  it("allows ordinary revisions", async () => {
    const { service } = makeService();
    const record = await service.remember({ userId: USER_ID, content: "Lives in Lyon" });

    const updated = await service.update({
      userId: USER_ID,
      id: record.id,
      content: "Lives in Paris",
    });

    expect(updated?.content).toBe("Lives in Paris");
    expect(updated?.supersedesId).toBe(record.id);
  });

  it("does not reach another user's memory", async () => {
    const { service } = makeService();
    const record = await service.remember({ userId: OTHER_USER, content: "Other user's memory" });

    expect(
      await service.update({ userId: USER_ID, id: record.id, content: "hijacked" }),
    ).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Forgetting memories
// ─────────────────────────────────────────────────────────────────────────────

describe("forget", () => {
  it("forgets by identifier and returns removed record", async () => {
    const { service } = makeService();
    const record = await service.remember({ userId: USER_ID, content: "Lives in Lyon" });

    const result = await service.forget({ userId: USER_ID, id: record.id });

    expect(result.forgotten.map((r) => r.content)).toEqual(["Lives in Lyon"]);
  });

  it("forgets by text when match is unambiguous", async () => {
    const { service } = makeService();
    await service.remember({ userId: USER_ID, content: "Lives in Lyon" });
    await service.remember({ userId: USER_ID, content: "Prefers dark roast coffee" });

    const result = await service.forget({ userId: USER_ID, match: "lives lyon" });

    expect(result.forgotten).toHaveLength(1);
    expect(result.ambiguous).toEqual([]);
  });

  it("does not guess when multiple memories match", async () => {
    const { service } = makeService();
    await service.remember({ userId: USER_ID, content: "Team sync on Monday" });
    await service.remember({ userId: USER_ID, content: "Team sync on Tuesday" });

    const result = await service.forget({ userId: USER_ID, match: "team sync" });

    expect(result.forgotten).toEqual([]);
    expect(result.ambiguous).toHaveLength(2);
  });

  it("finds nothing cleanly without error", async () => {
    const { service } = makeService();

    const result = await service.forget({ userId: USER_ID, match: "something absent" });

    expect(result.forgotten).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("requires confirmation to purge all memories", async () => {
    const { service, provider } = makeService();
    await service.remember({ userId: USER_ID, content: "A memory" });

    const result = await service.forget({ userId: USER_ID, all: true });

    expect(result.needsConfirmation).toBe(true);
    expect(provider.size).toBe(1);
  });

  it("purges all memories once confirmed, and nothing more", async () => {
    const { service, provider } = makeService();
    await service.remember({ userId: USER_ID, content: "Alex's memory" });
    await service.remember({ userId: OTHER_USER, content: "Other user's memory" });

    const result = await service.forget({ userId: USER_ID, all: true, confirmed: true });

    expect(result.forgotten).toHaveLength(1);
    expect(provider.size).toBe(1);
  });

  it("does not delete another user's memory by identifier", async () => {
    const { service, provider } = makeService();
    const record = await service.remember({ userId: OTHER_USER, content: "Other user's memory" });

    const result = await service.forget({ userId: USER_ID, id: record.id });

    expect(result.forgotten).toEqual([]);
    expect(provider.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Explicit commands
// ─────────────────────────────────────────────────────────────────────────────

describe("explicit commands", () => {
  it("executes remember command", async () => {
    const { service } = makeService();

    const outcome = await service.handleCommand(USER_ID, "Retiens que je préfère le train");

    expect(outcome?.stored?.content).toBe("je préfère le train");
    expect(outcome?.message).toContain("Noted");
  });

  it("user-dictated memories carry higher importance than inferences", async () => {
    const { service } = makeService();

    const outcome = await service.handleCommand(USER_ID, "Retiens que je préfère le train");

    expect(outcome?.stored?.origin).toBe("USER");
    expect(outcome?.stored?.importance).toBeGreaterThan(0.5);
  });

  it("executes forget command", async () => {
    const { service } = makeService();
    await service.remember({ userId: USER_ID, content: "j'habite à Lyon" });

    const outcome = await service.handleCommand(USER_ID, "Oublie que j'habite à Lyon");

    expect(outcome?.forgotten?.forgotten).toHaveLength(1);
    expect(outcome?.message).toContain("Forgotten");
  });

  it("dictated commands undergo identical classification as API calls", async () => {
    const { service } = makeService();

    await expect(
      service.handleCommand(USER_ID, "Retiens que mon mot de passe est Tr0ub4dor3xy"),
    ).rejects.toThrow(SensitiveMemoryRefusedError);
  });

  it("forgetting everything asks for confirmation", async () => {
    const { service } = makeService();
    await service.remember({ userId: USER_ID, content: "A memory" });

    const outcome = await service.handleCommand(USER_ID, "Oublie tout");

    expect(outcome?.forgotten?.needsConfirmation).toBe(true);
    expect(outcome?.message).toContain("irreversible");
  });

  it("returns undefined when input is not a command", async () => {
    const { service } = makeService();

    expect(await service.handleCommand(USER_ID, "What is the weather?")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

describe("reading", () => {
  it("lists all stored memories for a user", async () => {
    const { service } = makeService();
    await service.remember({ userId: USER_ID, content: "Memory A" });
    await service.remember({ userId: USER_ID, content: "Memory B" });
    await service.remember({ userId: OTHER_USER, content: "Other user's memory" });

    const hits = await service.list({ userId: USER_ID });

    expect(hits).toHaveLength(2);
  });

  it("lists a single layer at a time", async () => {
    const { service } = makeService();
    await service.remember({ userId: USER_ID, content: "Reply concisely", layer: "PREFERENCE" });
    await service.remember({ userId: USER_ID, content: "Lives in Lyon" });

    const preferences = await service.list({ userId: USER_ID, layer: "PREFERENCE" });

    expect(preferences.map((hit) => hit.record.content)).toEqual(["Reply concisely"]);
  });
});
