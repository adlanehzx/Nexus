/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method --
   Test doubles implement async/Promise-returning interfaces without awaiting and use loose fetch mocks. */
import { describe, it, expect, vi } from "vitest";
import { osintMissionInputSchema } from "@nexus/osint";
import type { OsintMission } from "@nexus/osint";
import type { LLMProvider } from "@nexus/llm";
import { OsintService, fetchOsintPublicText } from "../src/services/osint-service.js";
import { OsintMissionService } from "../src/services/osint-missions.js";
import { createOsintCollectors, type OsintCollector } from "../src/services/osint-collectors.js";
import { SafeWebFetcher } from "@nexus/web-search";

function model() {
  const generate = vi
    .fn()
    .mockResolvedValueOnce({
      content: [{ type: "text", text: '["search"]' }],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "mock",
      stopReason: "end_turn",
    })
    .mockResolvedValue({
      content: [{ type: "text", text: "# Report\nSources reviewed; identity unverified." }],
      usage: { inputTokens: 10, outputTokens: 10 },
      model: "mock",
      stopReason: "end_turn",
    });
  return {
    generate,
    countTokens: vi.fn().mockResolvedValue(10),
    model: "mock",
  } as unknown as LLMProvider;
}
const input = (overrides: Record<string, unknown> = {}) =>
  osintMissionInputSchema.parse({
    title: "Public investigation",
    targets: [{ type: "domain", value: "example.org" }],
    lawfulPurposeConfirmed: true,
    config: { collectors: ["search"], sourceCategories: ["web"], ...overrides },
  });
const finding = {
  url: "https://example.org/source",
  title: "Public source",
  content: "contact@example.org",
  confidence: 0.5,
  targets: [
    { type: "email" as const, value: "contact@example.org" },
    { type: "email" as const, value: "CONTACT@example.org" },
  ],
};
function collector(collect = vi.fn().mockResolvedValue([finding])): OsintCollector {
  return { id: "search", category: "web", minIntervalMs: 0, supports: () => true, collect };
}
async function terminal(service: OsintMissionService, id: string) {
  await vi.waitFor(async () =>
    expect(["completed", "failed", "cancelled"]).toContain((await service.get("owner", id)).status),
  );
  return service.get("owner", id);
}
describe("autonomous OSINT missions", () => {
  it("plans with the shared Planner, collects, deduplicates and enforces pivot depth", async () => {
    const c = collector();
    const cases = new OsintService();
    const llm = model();
    const service = new OsintMissionService({ cases, llm, collectors: [c] });
    const m = await service.create("owner", input({ maxDepth: 1 }));
    const result = await terminal(service, m.id);
    expect(result.status).toBe("completed");
    expect(c.collect).toHaveBeenCalledTimes(2);
    const record = await cases.get("owner", m.caseId);
    expect(record?.entities).toHaveLength(2);
    expect(record?.relations).toHaveLength(1);
    expect(record?.evidence[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.evidence[0]?.observedAt).toBeTruthy();
    expect(result.timeline.some((e) => e.action === "plan")).toBe(true);
    expect(result.report).toContain("Report");
    await expect(service.get("other", m.id)).rejects.toThrow("not found");
  });
  it("does not pivot beyond depth zero and stops at iteration limit", async () => {
    const c = collector();
    const service = new OsintMissionService({
      cases: new OsintService(),
      llm: model(),
      collectors: [c],
    });
    const m = await service.create("owner", input({ maxDepth: 0 }));
    expect((await terminal(service, m.id)).iterations).toBe(1);
    expect(c.collect).toHaveBeenCalledTimes(1);
    const limited = new OsintMissionService({
      cases: new OsintService(),
      llm: model(),
      collectors: [collector()],
    });
    const other = await limited.create("owner", input({ maxIterations: 1 }));
    const result = await terminal(limited, other.id);
    expect(result.status).toBe("completed");
    expect(result.iterations).toBe(1);
    expect(result.reason).toContain("Iteration limit");
  });
  it("fails visibly when LLM or search is unavailable", async () => {
    const missing = new OsintMissionService({ cases: new OsintService() });
    const m = await missing.create("owner", input());
    expect((await terminal(missing, m.id)).reason).toContain("not configured");
    const c = collector(vi.fn().mockRejectedValue(new Error("SearXNG is unreachable")));
    const s = new OsintMissionService({ cases: new OsintService(), llm: model(), collectors: [c] });
    expect((await terminal(s, (await s.create("owner", input())).id)).reason).toContain("SearXNG");
  });
  it("stops before an unaffordable model request", async () => {
    const llm = model();
    vi.mocked(llm.countTokens).mockResolvedValue(1000);
    const s = new OsintMissionService({
      cases: new OsintService(),
      llm,
      collectors: [collector()],
    });
    const m = await s.create("owner", input({ maxLlmTokens: 256 }));
    expect((await terminal(s, m.id)).reason).toContain("budget");
    expect(llm.generate).not.toHaveBeenCalled();
  });
  it("pauses, resumes, cancels and records controls without losing frontier", async () => {
    const collect = vi
      .fn()
      .mockImplementation(
        (_t, _c, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          ),
      );
    const s = new OsintMissionService({
      cases: new OsintService(),
      llm: model(),
      collectors: [collector(collect)],
    });
    const m = await s.create("owner", input());
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    expect((await s.control("owner", m.id, "pause")).status).toBe("paused");
    expect((await s.get("owner", m.id)).frontier).toHaveLength(1);
    await s.control("owner", m.id, "resume");
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    const cancelled = await s.control("owner", m.id, "cancel");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.timeline.map((e) => e.action)).toEqual(
      expect.arrayContaining(["pause", "resume", "cancel"]),
    );
  });
  it("enforces the deadline during collection", async () => {
    const clock = vi.spyOn(Date, "now");
    const initial = Date.now();
    const collect = vi.fn().mockImplementation(async () => {
      clock.mockReturnValue(initial + 11000);
      return [finding];
    });
    try {
      const s = new OsintMissionService({
        cases: new OsintService(),
        llm: model(),
        collectors: [collector(collect)],
      });
      const m = await s.create("owner", input({ maxDurationSeconds: 10 }));
      expect((await terminal(s, m.id)).reason).toContain("duration limit");
    } finally {
      clock.mockRestore();
    }
  });
  it("dispatches enabled collectors in parallel", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = collector(
      vi.fn().mockImplementation(async () => {
        await barrier;
        return [];
      }),
    );
    const second: OsintCollector = {
      ...collector(
        vi.fn().mockImplementation(async () => {
          release();
          return [];
        }),
      ),
      id: "dns",
    };
    const s = new OsintMissionService({
      cases: new OsintService(),
      llm: model(),
      collectors: [first, second],
    });
    const m = await s.create("owner", input({ collectors: ["search", "dns"], maxDepth: 0 }));
    expect((await terminal(s, m.id)).status).toBe("completed");
    expect(second.collect).toHaveBeenCalledOnce();
  });
  it("rejects private collector fetches before network access", async () => {
    const fetch = vi.fn();
    const safe = new SafeWebFetcher({ fetch });
    await expect(safe.fetch({ url: "http://127.0.0.1/private" })).rejects.toThrow();
    await expect(fetchOsintPublicText("https://localhost/private")).rejects.toThrow();
    await expect(fetchOsintPublicText("https://127.0.0.1/private")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const page = createOsintCollectors().find((c) => c.id === "page")!;
    await expect(
      page.collect(
        { type: "url", value: "http://169.254.169.254/" },
        input().config,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});

it("restores interrupted missions as paused and retains their audit trail", async () => {
  const saved: OsintMission[] = [];
  const persistence = {
    loadMissions: async () => structuredClone(saved),
    saveMission: async (m: OsintMission) => {
      saved.splice(0, saved.length, structuredClone(m));
    },
    loadCases: async () => [],
    saveCase: async () => undefined,
    importCases: async () => undefined,
  };
  const s = new OsintMissionService({ cases: new OsintService(), persistence });
  const m = await s.create("owner", input());
  await terminal(s, m.id);
  saved[0]!.status = "running";
  const restarted = new OsintMissionService({ cases: new OsintService(), persistence });
  const restored = await restarted.get("owner", m.id);
  expect(restored.status).toBe("paused");
  expect(restored.timeline.at(-1)?.action).toBe("recovered");
});
