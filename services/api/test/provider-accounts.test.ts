import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";
import type { ProviderAccount } from "../src/services/provider-accounts.js";

describe("Provider multi-account management", () => {
  let harness: ApiHarness;
  let admin: Account;
  let membre: Account;
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "nexus-test-accounts-"));
    const runtimeConfiguration = new RuntimeConfigurationStore(configDir);
    harness = await makeApi({ runtimeConfiguration });
    admin = await createAccount(harness, "admin@nexus.local");
    membre = await createAccount(harness, "membre@nexus.local");
  });

  afterEach(async () => {
    await harness.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it("generates default accounts and returns them to administrator", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/accounts",
      headers: admin.authorization,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { accounts: ProviderAccount[] } }>();
    expect(body.data.accounts.length).toBeGreaterThanOrEqual(3);

    const ids = body.data.accounts.map((a) => a.id);
    expect(ids).toContain("antigravity-personnel");
    expect(ids).toContain("claude-principal");
    expect(ids).toContain("codex-principal");

    // Verify no secret is exposed
    for (const acc of body.data.accounts) {
      expect(acc).not.toHaveProperty("secret");
      expect(acc).not.toHaveProperty("apiKey");
      expect(acc).not.toHaveProperty("token");
    }
  });

  it("denies access to accounts for non-admin users", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/accounts",
      headers: membre.authorization,
    });

    expect(res.statusCode).toBe(403);
  });

  it("allows creating a new identity with isolated session", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts",
      headers: admin.authorization,
      payload: {
        id: "antigravity-secondaire",
        provider: "antigravity",
        name: "Antigravity Secondary (Pro)",
        profileKey: "antigravity",
        priority: 2,
        metadata: { tier: "backup" },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: ProviderAccount }>();
    expect(body.data.id).toBe("antigravity-secondaire");
    expect(body.data.priority).toBe(2);
    expect(body.data.sessionDir).toContain("antigravity-secondaire");
    expect(body.data.reliability.score).toBe(1.0);
  });

  it("updates and deletes an identity", async () => {
    // Creation
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts",
      headers: admin.authorization,
      payload: {
        id: "claude-backup",
        provider: "claude",
        name: "Claude Backup",
        profileKey: "claude",
        priority: 3,
      },
    });

    // Update
    const patchRes = await harness.app.inject({
      method: "PATCH",
      url: "/api/v1/orchestrator/accounts/claude-backup",
      headers: admin.authorization,
      payload: {
        name: "Claude Backup Renamed",
        priority: 2,
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json<{ data: ProviderAccount }>();
    expect(patched.data.name).toBe("Claude Backup Renamed");
    expect(patched.data.priority).toBe(2);

    // Deletion
    const delRes = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/orchestrator/accounts/claude-backup",
      headers: admin.authorization,
    });

    expect(delRes.statusCode).toBe(200);

    // Verify identity no longer exists
    const getRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/accounts/claude-backup",
      headers: admin.authorization,
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("handles manual activation and release of cooldown", async () => {
    const activateRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts/claude-principal/cooldown",
      headers: admin.authorization,
      payload: {
        active: true,
        durationSeconds: 120,
        reason: "Scheduled maintenance",
      },
    });

    expect(activateRes.statusCode).toBe(200);
    const activated = activateRes.json<{ data: ProviderAccount }>();
    expect(activated.data.cooldown.active).toBe(true);
    expect(activated.data.cooldown.reason).toBe("Scheduled maintenance");
    expect(activated.data.cooldown.until).not.toBeNull();

    // Cooldown release
    const clearRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts/claude-principal/cooldown",
      headers: admin.authorization,
      payload: {
        active: false,
      },
    });

    expect(clearRes.statusCode).toBe(200);
    const cleared = clearRes.json<{ data: ProviderAccount }>();
    expect(cleared.data.cooldown.active).toBe(false);
    expect(cleared.data.cooldown.reason).toBeNull();
  });

  it("tests and probes authentication status", async () => {
    const probeRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts/claude-principal/test",
      headers: admin.authorization,
    });

    expect(probeRes.statusCode).toBe(200);
    const probed = probeRes.json<{ data: ProviderAccount }>();
    expect(probed.data.authStatus).toBe("authenticated");
    expect(probed.data.lastCheckedAt).not.toBeNull();
  });

  it("records successes and failures with reliability score calculation and auto-cooldown", async () => {
    const service = harness.services.providerAccounts;
    expect(service).toBeDefined();
    if (!service) return;

    // Record 3 successes
    await service.recordOutcome("claude-principal", { success: true });
    await service.recordOutcome("claude-principal", { success: true });
    await service.recordOutcome("claude-principal", { success: true });

    let acc = await service.getAccount("claude-principal");
    expect(acc?.reliability.totalRuns).toBe(3);
    expect(acc?.reliability.successCount).toBe(3);
    expect(acc?.reliability.score).toBe(1.0);

    // Record 1 rate limit failure
    await service.recordOutcome("claude-principal", {
      success: false,
      errorCategory: "rate_limited",
    });

    acc = await service.getAccount("claude-principal");
    expect(acc?.reliability.totalRuns).toBe(4);
    expect(acc?.reliability.successCount).toBe(3);
    expect(acc?.reliability.failureCount).toBe(1);
    expect(acc?.reliability.consecutiveFailures).toBe(1);
    expect(acc?.reliability.score).toBe(0.75);
    expect(acc?.cooldown.active).toBe(true);
    expect(acc?.cooldown.reason).toContain("Rate limit");
  });

  it("intelligently selects account based on priority, cooldown, and reliability", async () => {
    const service = harness.services.providerAccounts;
    expect(service).toBeDefined();
    if (!service) return;

    // Create secondary identity for Antigravity
    await service.createAccount({
      id: "antigravity-secondaire",
      provider: "antigravity",
      name: "Antigravity Backup",
      profileKey: "antigravity",
      priority: 2,
    });

    // Initially, antigravity-personnel has priority 1 vs antigravity-secondaire priority 2
    let selected = await service.selectAccount("antigravity");
    expect(selected?.id).toBe("antigravity-personnel");

    // Put main account into cooldown
    await service.setCooldown("antigravity-personnel", 300, "Too many requests");

    // Selection automatically switches to antigravity-secondaire
    selected = await service.selectAccount("antigravity");
    expect(selected?.id).toBe("antigravity-secondaire");
  });
});
