import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Backoff } from "../src/backoff.js";
import { LocalCapabilityRegistry, type LocalCapability } from "../src/capabilities.js";
import { LoopbackLink } from "../src/link.js";
import { MemoryWorkerLogger } from "../src/logging.js";
import { TaskRunner, maskSecretFields, toWireError, withTimeout } from "../src/task-runner.js";
import { CapabilityUnavailableError, ExecutionTimeoutError } from "../src/errors.js";
import type { WorkerPayload } from "@nexus/protocol";

/**
 * Le runtime commun, éprouvé pour lui-même.
 *
 * Les workers Windows et Android l'exercent déjà de bout en bout ; ces tests
 * couvrent ce qui n'appartient à aucun des deux — les contrats du registre, la
 * rédaction des arguments, la forme des erreurs de fil.
 *
 * Ce paquet ne doit dépendre d'**aucune** API de Node : il tourne aussi sur
 * Hermes, le moteur JavaScript d'Android. Un test le vérifie sur le code source.
 */

function capability(overrides: Partial<LocalCapability<never, unknown>> = {}) {
  return {
    name: "test.echo",
    description: "Renvoie ce qu'on lui donne.",
    inputSchema: z.object({ value: z.string() }),
    riskLevel: "SAFE" as const,
    execute: (input: { value: string }) => Promise.resolve({ echoed: input.value }),
    ...overrides,
  } as unknown as LocalCapability<never, unknown>;
}

describe("registre de capacités", () => {
  it("annonce ce qui est enregistré", async () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability());
    await registry.probeAll();

    expect(registry.declare().map((entry) => entry.name)).toEqual(["test.echo"]);
  });

  it("refuse un enregistrement en double", () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability());
    expect(() => registry.register(capability())).toThrow(CapabilityUnavailableError);
  });

  it("écarte une capacité dont la sonde échoue", async () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability({ probe: () => Promise.reject(new Error("absent")) }));
    await registry.probeAll();

    // Une sonde en échec vaut une indisponibilité : dans le doute, on n'annonce pas.
    expect(registry.declare()).toEqual([]);
  });

  it("nomme le champ fautif quand les arguments sont invalides", () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability());

    expect(() => registry.validateInput("test.echo", { autre: 1 })).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_INPUT_INVALID",
        context: expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("value")]),
        }),
      }),
    );
  });

  it("transporte le risque dans les métadonnées annoncées", async () => {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability({ riskLevel: "HIGH" }));
    await registry.probeAll();

    expect(registry.declare()[0]?.metadata).toEqual({ risk: "HIGH" });
  });
});

describe("rédaction des arguments déclarés secrets", () => {
  it("masque les champs nommés par la capacité", () => {
    const masked = maskSecretFields({ selector: "champ", text: "MonMotDePasse" }, ["text"]);
    expect(masked).toEqual({ selector: "champ", text: "[REDACTED]" });
  });

  it("laisse la charge utile intacte sans déclaration", () => {
    const input = { text: "visible" };
    expect(maskSecretFields(input, undefined)).toBe(input);
    expect(maskSecretFields(input, [])).toBe(input);
  });

  it("ignore un champ absent", () => {
    expect(maskSecretFields({ a: 1 }, ["text"])).toEqual({ a: 1 });
  });

  it("laisse passer ce qui n'est pas un objet", () => {
    expect(maskSecretFields("texte", ["text"])).toBe("texte");
    expect(maskSecretFields([1, 2], ["text"])).toEqual([1, 2]);
  });
});

describe("erreurs de fil", () => {
  it("respecte le code et la reprise d'une AppError", () => {
    const wire = toWireError(new ExecutionTimeoutError("test.echo", 1_000));
    expect(wire).toMatchObject({ code: "EXECUTION_TIMEOUT", retryable: true });
  });

  it("ne transmet pas le message d'une exception inconnue", () => {
    // Un message d'exception peut contenir un chemin, une variable
    // d'environnement, un fragment de fichier. Il reste local.
    const wire = toWireError(new Error("ENOENT: /home/adlan/.ssh/id_ed25519"));

    expect(wire.code).toBe("WORKER_INTERNAL_ERROR");
    expect(wire.message).not.toContain("id_ed25519");
    expect(wire.retryable).toBe(false);
  });
});

describe("délai d'exécution", () => {
  it("laisse passer une promesse rapide", async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, () => undefined, "x")).resolves.toBe(42);
  });

  it("déclenche l'annulation coopérative avant de rejeter", async () => {
    const onTimeout = vi.fn();
    const pending = withTimeout(new Promise(() => undefined), 20, onTimeout, "test.echo");

    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});

describe("exécution d'une étape", () => {
  function makeRunner(overrides: Partial<LocalCapability<never, unknown>> = {}) {
    const registry = new LocalCapabilityRegistry();
    registry.register(capability(overrides));

    const results: WorkerPayload<"worker.task_result">[] = [];
    const logger = new MemoryWorkerLogger();

    const runner = new TaskRunner({
      capabilities: registry,
      logger,
      sendProgress: () => Promise.resolve(),
      sendResult: (payload) => {
        results.push(payload);
        return Promise.resolve();
      },
      maxConcurrentTasks: 1,
      defaultTimeoutMs: 5_000,
    });

    return { runner, results, logger, registry };
  }

  function dispatch(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
    return {
      taskId: "t1",
      stepId: "s1",
      capability: "test.echo",
      tool: "device.test.echo",
      arguments: { value: "bonjour" },
      timeoutMs: 1_000,
      riskLevel: "SAFE",
      requestId: "r1",
      ...overrides,
    };
  }

  it("exécute et renvoie un résultat", async () => {
    const { runner, results } = makeRunner();
    await runner.handleDispatch(dispatch());

    expect(results[0]).toMatchObject({ ok: true, result: { echoed: "bonjour" } });
  });

  it("marque le résultat sensible quand la capacité le déclare", async () => {
    const { runner, results } = makeRunner({ sensitiveResult: true });
    await runner.handleDispatch(dispatch());

    expect(results[0]?.sensitiveResult).toBe(true);
  });

  it("ne journalise pas un argument déclaré secret", async () => {
    const { runner, logger } = makeRunner({ secretArguments: ["value"] });
    await runner.handleDispatch(dispatch({ arguments: { value: "MonMotDePasse2026" } }));

    expect(logger.text).not.toContain("MonMotDePasse2026");
    expect(logger.text).toContain("REDACTED");
  });

  it("refuse un renvoi de la même requête", async () => {
    const { runner, results } = makeRunner();
    await runner.handleDispatch(dispatch());
    await runner.handleDispatch(dispatch());

    // Le cœur peut renvoyer un ordre après une coupure : on ne réexécute pas.
    expect(results).toHaveLength(1);
  });

  it("ne lève jamais : toute issue devient un résultat", async () => {
    const { runner, results } = makeRunner();
    await expect(
      runner.handleDispatch(dispatch({ capability: "inconnue.capacite" })),
    ).resolves.toBeUndefined();

    expect(results[0]).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });
});

describe("attente exponentielle", () => {
  it("croît puis plafonne", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 8_000, jitter: 0, random: () => 0.5 });
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
  });

  it("repart à zéro après une connexion établie", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0, random: () => 0.5 });
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});

describe("canal en mémoire", () => {
  it("achemine les enveloppes dans les deux sens", async () => {
    const link = new LoopbackLink();
    const received: unknown[] = [];
    link.onMessage((envelope) => received.push(envelope));

    await link.connect();
    await link.send({
      v: 1,
      id: "1",
      type: "worker.hello",
      ts: new Date().toISOString(),
      payload: {},
    });
    link.deliver({ descendant: true });

    expect(link.sent).toHaveLength(1);
    expect(received).toEqual([{ descendant: true }]);
  });

  it("signale la fermeture une seule fois", async () => {
    const link = new LoopbackLink();
    const reasons: string[] = [];
    link.onClose((reason) => reasons.push(reason));

    await link.connect();
    await link.close("test");
    await link.close("test");

    expect(reasons).toEqual(["test"]);
  });
});

describe("portabilite du runtime", () => {
  /**
   * Ce paquet tourne sur Node **et** sur Hermes, le moteur JavaScript
   * d'Android. Une seule importation de `node:` suffirait a casser le bundle du
   * worker Android, et l'erreur n'apparaitrait qu'a l'execution sur le
   * telephone — au pire endroit possible pour la decouvrir.
   */
  it("n'importe aucune API de Node", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const source = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
    const offenders: string[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;

        const content = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        if (/from "node:|require\("node:/.test(content)) offenders.push(entry);
        if (/\bprocess\.(stdout|stderr|env)\b/.test(content)) offenders.push(`${entry} (process)`);
      }
    };

    walk(source);
    expect(offenders).toEqual([]);
  });
});
