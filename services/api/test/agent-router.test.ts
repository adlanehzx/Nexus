import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { AgentRouter } from "../src/services/agent-router.js";
import { ProviderAccountService } from "../src/services/provider-accounts.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

describe("Intelligent Agent Routing", () => {
  let harness: ApiHarness;
  let admin: Account;
  let member: Account;
  let configDir: string;
  let router: AgentRouter;
  let accountsService: ProviderAccountService;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "nexus-test-router-"));
    const runtimeConfiguration = new RuntimeConfigurationStore(configDir);
    accountsService = new ProviderAccountService({ runtimeConfiguration });
    router = new AgentRouter({
      runtimeConfiguration,
      providerAccounts: accountsService,
    });
    harness = await makeApi({ runtimeConfiguration });
    admin = await createAccount(harness, "admin@nexus.local");
    member = await createAccount(harness, "member@nexus.local");
  });

  afterEach(async () => {
    await harness.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it("correctly classifies task types and requirements", () => {
    // 1. Code task
    const codeTask = router.classifyTask("Write a TypeScript function with unit tests");
    expect(codeTask.primaryCategory).toBe("code");
    expect(codeTask.requiresBrowser).toBe(false);

    // 2. Research task
    const researchTask = router.classifyTask("Research and analyze official Fastify documentation");
    expect(researchTask.primaryCategory).toBe("research");

    // 3. Review task
    const reviewTask = router.classifyTask(
      "Perform a critical security review to detect contradictions",
    );
    expect(reviewTask.primaryCategory).toBe("review");

    // 4. Browser task
    const browserTask = router.classifyTask("Open Chromium browser and click the login button");
    expect(browserTask.primaryCategory).toBe("browser");
    expect(browserTask.requiresBrowser).toBe(true);

    // 5. Synthesis task
    const synthesisTask = router.classifyTask("Write the final synthesis and summary of results");
    expect(synthesisTask.primaryCategory).toBe("synthesis");
  });

  it("ranks agents according to task affinity and constraints", async () => {
    const profiles = ["antigravity", "claude", "codex"];

    // For code: Codex should have the highest score
    const codeRanked = await router.rankProfiles(
      profiles,
      "Implement a TypeScript module and write tests",
    );
    expect(codeRanked[0]?.key).toBe("codex");

    // For review: Claude should be on top
    const reviewRanked = await router.rankProfiles(
      profiles,
      "Perform a detailed critical review and validate verdict",
    );
    expect(reviewRanked[0]?.key).toBe("claude");

    // For research: Antigravity should be on top
    const researchRanked = await router.rankProfiles(
      profiles,
      "Explore and research documentary facts",
    );
    expect(researchRanked[0]?.key).toBe("antigravity");
  });

  it("downgrades or eliminates an agent on cooldown or exhausted quota", async () => {
    const profiles = ["antigravity", "claude", "codex"];

    // Put Codex on cooldown
    await accountsService.setCooldown("codex-principal", 300, "Too many requests");

    // Even on a code task, Codex should be marked unavailable or score 0
    const codeRanked = await router.rankProfiles(profiles, "Implement a build script");
    const codexScore = codeRanked.find((r) => r.key === "codex");
    expect(codexScore?.isAvailable).toBe(false);
    expect(codexScore?.totalScore).toBe(0);

    // The first available choice should then be Claude
    const best = await router.bestProfileFor(profiles, "Implement a build script");
    expect(best).toBe("claude");
  });

  it("handles historical learning by task category", async () => {
    const profiles = ["antigravity", "claude", "codex"];
    const task = "Write a sorting function in Python";

    // Record several successes for Claude in code
    await router.recordOutcome("claude", "code", {
      success: true,
      durationMs: 8000,
      qualityVerdict: "pass",
    });
    await router.recordOutcome("claude", "code", {
      success: true,
      durationMs: 7000,
      qualityVerdict: "pass",
    });
    await router.recordOutcome("claude", "code", {
      success: true,
      durationMs: 7500,
      qualityVerdict: "pass",
    });

    // Record failures for Codex in code
    await router.recordOutcome("codex", "code", {
      success: false,
      durationMs: 25000,
      qualityVerdict: "revise",
    });

    const ranked = await router.rankProfiles(profiles, task);
    // Thanks to learning, Claude overtakes Codex for this task
    expect(ranked[0]?.key).toBe("claude");
  });

  it("exposes routing matrix and evaluation via API", async () => {
    // 0. Verify only an administrator can access routing matrix
    const forbiddenRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/routing/matrix",
      headers: member.authorization,
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // 1. GET /api/v1/orchestrator/routing/matrix
    const matrixRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/routing/matrix",
      headers: admin.authorization,
    });

    expect(matrixRes.statusCode).toBe(200);
    const matrixBody = matrixRes.json<{ data: { matrix: unknown[] } }>();
    expect(Array.isArray(matrixBody.data.matrix)).toBe(true);

    // 2. POST /api/v1/orchestrator/routing/evaluate
    const evalRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/routing/evaluate",
      headers: admin.authorization,
      payload: {
        instruction: "Research administrative documents and verify their integrity",
      },
    });

    expect(evalRes.statusCode).toBe(200);
    const evalBody = evalRes.json<{
      data: {
        classification: { primaryCategory: string };
        ranked: { key: string; totalScore: number }[];
      };
    }>();
    expect(evalBody.data.classification.primaryCategory).toBe("research");
    expect(evalBody.data.ranked.length).toBeGreaterThan(0);

    // 3. POST /api/v1/orchestrator/routing/reset
    const resetRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/routing/reset",
      headers: admin.authorization,
    });
    expect(resetRes.statusCode).toBe(200);
  });
});
