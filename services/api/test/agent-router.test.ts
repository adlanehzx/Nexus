import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { AgentRouter } from "../src/services/agent-router.js";
import { ProviderAccountService } from "../src/services/provider-accounts.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

describe("Routage intelligent des agents (Chantier 13)", () => {
  let harness: ApiHarness;
  let admin: Account;
  let membre: Account;
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
    membre = await createAccount(harness, "membre@nexus.local");
  });

  afterEach(async () => {
    await harness.close();
    await rm(configDir, { recursive: true, force: true });
  });

  it("classifie correctement les natures de tâches et exigences", () => {
    // 1. Tâche de code
    const codeTask = router.classifyTask("Écris une fonction TypeScript avec des tests unitaires");
    expect(codeTask.primaryCategory).toBe("code");
    expect(codeTask.requiresBrowser).toBe(false);

    // 2. Tâche de recherche
    const researchTask = router.classifyTask("Recherche et analyse la documentation officielle de Fastify");
    expect(researchTask.primaryCategory).toBe("research");

    // 3. Tâche de revue critique
    const reviewTask = router.classifyTask("Fais une revue critique de sécurité pour détecter les contradictions");
    expect(reviewTask.primaryCategory).toBe("review");

    // 4. Tâche navigateur
    const browserTask = router.classifyTask("Ouvre le navigateur Chromium et clique sur le bouton de connexion");
    expect(browserTask.primaryCategory).toBe("browser");
    expect(browserTask.requiresBrowser).toBe(true);

    // 5. Tâche de synthèse
    const synthesisTask = router.classifyTask("Rédige la synthèse finale et le bilan des résultats");
    expect(synthesisTask.primaryCategory).toBe("synthesis");
  });

  it("classe les agents selon l'affinité de tâche et les contraintes", async () => {
    const profiles = ["antigravity", "claude", "codex"];

    // Pour du code : Codex doit avoir le score le plus élevé
    const codeRanked = await router.rankProfiles(profiles, "Implémente un module TypeScript et écris les tests");
    expect(codeRanked[0]?.key).toBe("codex");

    // Pour de la critique : Claude doit être en tête
    const reviewRanked = await router.rankProfiles(profiles, "Fais une revue critique détaillée et valide le verdict");
    expect(reviewRanked[0]?.key).toBe("claude");

    // Pour de la recherche : Antigravity doit être en tête
    const researchRanked = await router.rankProfiles(profiles, "Explore et recherche les faits documentaires");
    expect(researchRanked[0]?.key).toBe("antigravity");
  });

  it("rétrograde ou élimine un agent en cooldown ou quota épuisé", async () => {
    const profiles = ["antigravity", "claude", "codex"];

    // Met Codex en cooldown
    await accountsService.setCooldown("codex-principal", 300, "Trop de requêtes");

    // Même sur une tâche de code, Codex doit être marqué indisponible ou score 0
    const codeRanked = await router.rankProfiles(profiles, "Implémente un script de build");
    const codexScore = codeRanked.find((r) => r.key === "codex");
    expect(codexScore?.isAvailable).toBe(false);
    expect(codexScore?.totalScore).toBe(0);

    // Le premier choix disponible doit alors être Claude
    const best = await router.bestProfileFor(profiles, "Implémente un script de build");
    expect(best).toBe("claude");
  });

  it("gère l'apprentissage historique par catégorie de tâche", async () => {
    const profiles = ["antigravity", "claude", "codex"];
    const task = "Écris une fonction de tri en Python";

    // Enregistre plusieurs succès éclatants pour Claude dans le code
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

    // Enregistre des échecs pour Codex dans le code
    await router.recordOutcome("codex", "code", {
      success: false,
      durationMs: 25000,
      qualityVerdict: "revise",
    });

    const ranked = await router.rankProfiles(profiles, task);
    // Grâce à l'apprentissage, Claude dépasse Codex pour cette tâche
    expect(ranked[0]?.key).toBe("claude");
  });

  it("expose la matrice de routage et l'évaluation via l'API", async () => {
    // 0. Vérifier que seul un administrateur peut accéder à la matrice de routage
    const forbiddenRes = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/routing/matrix",
      headers: membre.authorization,
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
        instruction: "Recherche les documents administratifs et vérifie leur intégrité",
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
