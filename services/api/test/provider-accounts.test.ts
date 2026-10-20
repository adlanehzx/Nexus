import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";
import type { ProviderAccount } from "../src/services/provider-accounts.js";

describe("Gestion multi-comptes fournisseurs (Chantier 12)", () => {
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

  it("génère les comptes par défaut et les retourne à l'administrateur", async () => {
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

    // Vérifie qu'aucun secret n'est exposé
    for (const acc of body.data.accounts) {
      expect(acc).not.toHaveProperty("secret");
      expect(acc).not.toHaveProperty("apiKey");
      expect(acc).not.toHaveProperty("token");
    }
  });

  it("refuse l'accès aux comptes aux utilisateurs non administrateurs", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/accounts",
      headers: membre.authorization,
    });

    expect(res.statusCode).toBe(403);
  });

  it("permet la création d'une nouvelle identité avec session isolée", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts",
      headers: admin.authorization,
      payload: {
        id: "antigravity-secondaire",
        provider: "antigravity",
        name: "Antigravity Secondaire (Pro)",
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

  it("met à jour et supprime une identité", async () => {
    // Création
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

    // Mise à jour
    const patchRes = await harness.app.inject({
      method: "PATCH",
      url: "/api/v1/orchestrator/accounts/claude-backup",
      headers: admin.authorization,
      payload: {
        name: "Claude Backup Renommé",
        priority: 2,
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json<{ data: ProviderAccount }>();
    expect(patched.data.name).toBe("Claude Backup Renommé");
    expect(patched.data.priority).toBe(2);

    // Suppression
    const delRes = await harness.app.inject({
      method: "DELETE",
      url: "/api/v1/orchestrator/accounts/claude-backup",
      headers: admin.authorization,
    });

    expect(delRes.statusCode).toBe(200);

    // Vérifie que l'identité n'existe plus
    const getRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/accounts/claude-backup",
      headers: admin.authorization,
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("gère l'activation et la levée manuelle de cooldown", async () => {
    const activateRes = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/accounts/claude-principal/cooldown",
      headers: admin.authorization,
      payload: {
        active: true,
        durationSeconds: 120,
        reason: "Maintenance programmée",
      },
    });

    expect(activateRes.statusCode).toBe(200);
    const activated = activateRes.json<{ data: ProviderAccount }>();
    expect(activated.data.cooldown.active).toBe(true);
    expect(activated.data.cooldown.reason).toBe("Maintenance programmée");
    expect(activated.data.cooldown.until).not.toBeNull();

    // Levée de cooldown
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

  it("teste et sonde l'état d'authentification", async () => {
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

  it("enregistre les réussites et échecs avec calcul du score de fiabilité et auto-cooldown", async () => {
    const service = harness.services.providerAccounts;
    expect(service).toBeDefined();
    if (!service) return;

    // Enregistre 3 succès
    await service.recordOutcome("claude-principal", { success: true });
    await service.recordOutcome("claude-principal", { success: true });
    await service.recordOutcome("claude-principal", { success: true });

    let acc = await service.getAccount("claude-principal");
    expect(acc?.reliability.totalRuns).toBe(3);
    expect(acc?.reliability.successCount).toBe(3);
    expect(acc?.reliability.score).toBe(1.0);

    // Enregistre 1 échec de type rate limit
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

  it("sélectionne intelligemment le compte selon priorité, cooldown et fiabilité", async () => {
    const service = harness.services.providerAccounts;
    expect(service).toBeDefined();
    if (!service) return;

    // Crée une identité secondaire pour Antigravity
    await service.createAccount({
      id: "antigravity-secondaire",
      provider: "antigravity",
      name: "Antigravity Backup",
      profileKey: "antigravity",
      priority: 2,
    });

    // Initialement, antigravity-personnel a la priorité 1 vs antigravity-secondaire priorité 2
    let selected = await service.selectAccount("antigravity");
    expect(selected?.id).toBe("antigravity-personnel");

    // Met le compte principal en cooldown
    await service.setCooldown("antigravity-personnel", 300, "Trop de requêtes");

    // La sélection bascule automatiquement sur antigravity-secondaire
    selected = await service.selectAccount("antigravity");
    expect(selected?.id).toBe("antigravity-secondaire");
  });
});
