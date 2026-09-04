import { describe, expect, it } from "vitest";
import type { CapabilityContext, LocalCapabilityRegistry } from "@nexus/worker-core";
import { BrowserWorkerClient } from "@nexus/browser-client";
import { assembleBrowserHost } from "../src/assemble.js";
import { BROWSER_INTENTS, browseInputSchema } from "../src/capabilities/browse.js";
import { BROWSER_TOKEN, FakeBrowserWorker, testConfig } from "./fixtures.js";

/**
 * Les capacités, éprouvées isolément.
 *
 * Ce fichier ne monte ni cœur, ni session : il vérifie ce que les capacités
 * déclarent et ce qu'elles font du contrat HTTP. Le chemin complet
 * cœur → passerelle → runtime → capacité est éprouvé dans `integration.test.ts`.
 */

interface Rig {
  registry: LocalCapabilityRegistry;
  python: FakeBrowserWorker;
  sessions: ReturnType<typeof assembleBrowserHost>["sessions"];
}

function rig(overrides: Parameters<typeof testConfig>[0] = {}): Rig {
  const config = testConfig(overrides);
  const python = new FakeBrowserWorker(BROWSER_TOKEN);
  const client = new BrowserWorkerClient({
    baseUrl: config.browserWorkerUrl,
    token: config.browserWorkerToken,
    fetchImpl: python.fetch,
  });
  const assembled = assembleBrowserHost({ config, client });
  return { registry: assembled.capabilities, python, sessions: assembled.sessions };
}

/** Contexte d'exécution d'une capacité, tel que le runtime le fournit. */
function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    taskId: "task-1",
    stepId: "step-1",
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    onProgress: () => undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Déclaration
// ─────────────────────────────────────────────────────────────────────────────

describe("déclaration des capacités", () => {
  it("expose une capacité par intention, et pas une capacité générique", () => {
    // Le point de sécurité du lot. Une seule capacité `browser.act` porterait le
    // même risque pour lire un prix et pour payer — le système de permissions et
    // les confirmations n'auraient alors plus rien à distinguer.
    const { registry } = rig();

    expect(registry.names).toEqual([
      "browser.interact",
      "browser.login",
      "browser.navigate",
      "browser.purchase",
    ]);
  });

  it("gradue le risque de la lecture à l'achat", () => {
    const risks = Object.fromEntries(
      BROWSER_INTENTS.map((spec) => [spec.capability, spec.riskLevel]),
    );

    expect(risks).toEqual({
      "browser.navigate": "LOW",
      "browser.interact": "MEDIUM",
      "browser.login": "HIGH",
      "browser.purchase": "CRITICAL",
    });
  });

  it("n'expose aucune capacité d'exécution de code ni d'accès disque", () => {
    // `evaluate`, l'écriture de fichiers, le téléversement : rien de tout cela
    // ne doit exister ici. Le worker Python les retire aussi, pour toutes les
    // intentions — mais l'absence commence par ne pas les déclarer.
    const { registry } = rig();

    for (const name of registry.names) {
      expect(name).toMatch(/^browser\.(navigate|interact|login|purchase)$/);
    }
    expect(registry.names).not.toContain("browser.evaluate");
    expect(registry.names).not.toContain("terminal.execute");
    expect(registry.names).not.toContain("filesystem.read");
  });

  it("respecte la liste blanche de la configuration", () => {
    // Un déploiement qui ne veut pas d'achat automatique le dit une fois, dans
    // sa configuration, et la capacité n'est jamais annoncée au cœur.
    const { registry } = rig({ declaredCapabilities: ["browser.navigate"] });

    expect(registry.declare().map((entry) => entry.name)).toEqual(["browser.navigate"]);
    expect(() => registry.require("browser.purchase")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation des arguments
// ─────────────────────────────────────────────────────────────────────────────

describe("validation des arguments", () => {
  it("refuse des instructions vides ou démesurées", () => {
    expect(browseInputSchema.safeParse({ instructions: "" }).success).toBe(false);
    expect(browseInputSchema.safeParse({ instructions: "x".repeat(4_001) }).success).toBe(false);
    expect(browseInputSchema.safeParse({ instructions: "lis le prix" }).success).toBe(true);
  });

  it("refuse une URL qui n'en est pas une", () => {
    // Sans cette borne, `javascript:` ou `file:` arriveraient jusqu'au
    // navigateur — la politique de domaine du worker Python les refuserait,
    // mais mieux vaut ne pas les faire voyager.
    const parsed = browseInputSchema.safeParse({
      instructions: "lis la page",
      url: "javascript:alert(1)",
    });
    expect(parsed.success).toBe(false);
  });

  it("plafonne le nombre d'étapes", () => {
    expect(browseInputSchema.safeParse({ instructions: "va", maxSteps: 51 }).success).toBe(false);
    expect(browseInputSchema.safeParse({ instructions: "va", maxSteps: 0 }).success).toBe(false);
  });

  it("rejette les arguments invalides avant tout appel réseau", async () => {
    const { registry, python } = rig();

    expect(() => registry.validateInput("browser.navigate", { instructions: "" })).toThrow();
    await Promise.resolve();
    expect(python.launched).toEqual([]);
    expect(python.sessions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exécution
// ─────────────────────────────────────────────────────────────────────────────

describe("exécution", () => {
  it("transmet l'intention correspondant à la capacité", async () => {
    // C'est ici que la séparation devient réelle : le worker Python restreint
    // les actions à partir de cette intention. `browser.navigate` ne peut pas
    // cliquer, même si les instructions le demandent.
    const { registry, python } = rig();

    for (const spec of BROWSER_INTENTS) {
      const capability = registry.require(spec.capability);
      await capability.execute({ instructions: "fais quelque chose" } as never, context());
    }

    expect(python.launched.map((entry) => entry.intent)).toEqual([
      "read",
      "interact",
      "login",
      "purchase",
    ]);
  });

  it("préfixe les instructions avec l'URL de départ", async () => {
    const { registry, python } = rig();
    const capability = registry.require("browser.navigate");

    await capability.execute(
      { instructions: "relève le prix", url: "https://exemple.fr/vols" } as never,
      context(),
    );

    expect(python.launched[0]?.instructions).toBe(
      "Va sur https://exemple.fr/vols, puis : relève le prix",
    );
  });

  it("plafonne les étapes à la configuration, même si l'appelant demande plus", async () => {
    const { registry, python } = rig({ maxSteps: 5 });
    const capability = registry.require("browser.navigate");

    await capability.execute({ instructions: "cherche", maxSteps: 50 } as never, context());

    // Le plafond du déploiement gagne : une tâche qui boucle coûte des appels au
    // modèle et tient un navigateur ouvert.
    expect(python.launched).toHaveLength(1);
  });

  it("rend le résultat, les étapes et l'URL visitée", async () => {
    const { registry, python } = rig();
    python.outcome = {
      status: "succeeded",
      output: "Le billet coûte 129 €",
      steps: 4,
      events: [
        {
          type: "navigation",
          taskId: "task-1-step-1",
          sessionId: "sess-1",
          seq: 1,
          ts: new Date().toISOString(),
          url: "https://exemple.fr/vols",
          title: null,
        },
      ],
    };

    const capability = registry.require("browser.navigate");
    const result = (await capability.execute(
      { instructions: "prix du billet" } as never,
      context(),
    )) as { output: string; steps: number; visitedUrl: string | null; sessionId: string };

    expect(result.output).toBe("Le billet coûte 129 €");
    expect(result.steps).toBe(4);
    expect(result.visitedUrl).toBe("https://exemple.fr/vols");
    expect(result.sessionId).toBe("sess-1");
  });

  it("remonte la progression sans exposer le raisonnement complet", async () => {
    // Le tableau de bord montre ce que fait l'agent — une étape, une page, une
    // action — pas sa chaîne de pensée intégrale.
    const { registry, python } = rig();
    const long = "je réfléchis très longuement à ce que je vais faire ensuite ".repeat(10);
    python.outcome = {
      status: "succeeded",
      output: "fini",
      events: [
        {
          type: "thinking",
          taskId: "task-1-step-1",
          sessionId: "sess-1",
          seq: 1,
          ts: new Date().toISOString(),
          text: long,
        },
        {
          type: "progress",
          taskId: "task-1-step-1",
          sessionId: "sess-1",
          seq: 2,
          ts: new Date().toISOString(),
          step: 2,
          maxSteps: 10,
          note: null,
        },
      ],
    };

    const progress: { percent?: number; label?: string }[] = [];
    const capability = registry.require("browser.navigate");
    await capability.execute(
      { instructions: "va" } as never,
      context({
        onProgress: (entry: { percent?: number; label?: string }) => progress.push(entry),
      }),
    );

    const thinking = progress.find((entry) => entry.label?.startsWith("je réfléchis") === true);
    expect(thinking?.label?.length).toBeLessThanOrEqual(120);
    expect(progress).toContainEqual({ label: "Étape 2/10", percent: 20 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Erreurs
// ─────────────────────────────────────────────────────────────────────────────

describe("erreurs", () => {
  it("ne contourne pas une vérification humaine", async () => {
    // CAPTCHA ou second facteur : on s'arrête et on rend la main. Le message
    // est destiné à l'utilisateur, pas au journal.
    const { registry, python } = rig();
    python.outcome = {
      status: "needs_human",
      error: { code: "BROWSER_NEEDS_HUMAN", message: "Le site demande un code", retryable: false },
    };

    const capability = registry.require("browser.login");
    await expect(
      capability.execute({ instructions: "connecte-toi" } as never, context()),
    ).rejects.toMatchObject({ code: "BROWSER_NEEDS_HUMAN", retryable: false });
  });

  it("remonte un échec de navigation avec le code du worker", async () => {
    const { registry, python } = rig();
    python.outcome = {
      status: "failed",
      error: { code: "BROWSER_DOMAIN_BLOCKED", message: "domaine refusé", retryable: false },
    };

    const capability = registry.require("browser.navigate");
    await expect(
      capability.execute({ instructions: "va" } as never, context()),
    ).rejects.toMatchObject({ code: "BROWSER_TASK_FAILED", retryable: false });
  });

  it("distingue un worker injoignable d'une tâche échouée", async () => {
    // L'un est réessayable, l'autre non. Les confondre ferait boucler le cœur
    // sur une tâche qui échouera toujours, ou abandonner un service qui redémarre.
    const { registry, python } = rig();
    python.unreachable = true;

    const capability = registry.require("browser.navigate");
    await expect(
      capability.execute({ instructions: "va" } as never, context()),
    ).rejects.toMatchObject({ code: "BROWSER_WORKER_UNREACHABLE", retryable: true });
  });

  it("ne s'annonce pas quand le worker Python ne répond pas", async () => {
    const { registry, python } = rig();
    python.unreachable = true;
    await registry.probeAll();

    expect(registry.declare()).toEqual([]);
  });

  it("s'annonce de nouveau quand le worker Python revient", async () => {
    const { registry, python } = rig();
    python.unreachable = true;
    await registry.probeAll();

    python.unreachable = false;
    await registry.probeAll();

    expect(registry.declare()).toHaveLength(4);
  });
});
