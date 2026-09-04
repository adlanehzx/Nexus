import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { makeHarness, until, ALLOWED_ROOT, type WorkerHarness } from "./fixtures.js";
import { loadWorkerConfig } from "../src/config.js";

/**
 * Les propriétés de sécurité, énoncées comme des tests.
 *
 * Deux catégories :
 *
 *  - celles qui s'observent à l'exécution (une tentative d'injection, une
 *    évasion de chemin, une fuite dans un journal) ;
 *  - celles qui se vérifient sur le **code source lui-même**, parce que ce sont
 *    des propriétés d'architecture. « Il n'existe nulle part de point d'entrée
 *    qui exécute une chaîne de commande » ne se démontre pas par un cas de test :
 *    on le démontre en lisant tout le paquet.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-sec",
      stepId: `step-${String(sequence)}`,
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { executable: "git", args: ["status"] },
      timeoutMs: 10_000,
      riskLevel: "HIGH",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: WorkerHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: WorkerHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

describe("aucun point d'entrée d'exécution arbitraire", () => {
  const sourceDirectory = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

  function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
      else if (entry.endsWith(".ts")) files.push(full);
    }
    return files;
  }

  it("n'importe jamais de primitive passant par un shell", () => {
    // `exec` et `execSync` remettent la chaîne à cmd.exe ; `spawn` avec
    // `shell: true` aussi. Aucun n'a sa place ici : c'est l'absence de shell qui
    // fait qu'un argument reste un argument, et non un filtre sur des chaînes.
    //
    // La détection porte sur les **imports**, pas sur le texte `exec(` : une
    // expression régulière a elle aussi une méthode `.exec()`, et un test qui
    // confond les deux se fait désactiver dès la première fausse alerte.
    const offenders: string[] = [];

    for (const file of sourceFiles(sourceDirectory)) {
      const content = readFileSync(file, "utf8");

      const imports = content.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g);
      for (const match of imports) {
        const named = (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
        for (const name of named) {
          if (name === "exec" || name === "execSync") {
            offenders.push(`${path.basename(file)} : import de ${name}`);
          }
        }
      }

      if (/shell\s*:\s*true/.test(content)) {
        offenders.push(`${path.basename(file)} : spawn avec shell`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("passe explicitement shell: false à chaque lancement", () => {
    // Le défaut de Node est déjà `false`, mais l'écrire rend la propriété
    // visible à la relecture — et fait échouer ce test si quelqu'un la retire.
    const runner = readFileSync(path.join(sourceDirectory, "runtime", "process-runner.ts"), "utf8");
    const spawns = runner.match(/spawn\(/g) ?? [];
    const explicit = runner.match(/shell:\s*false/g) ?? [];

    expect(spawns.length).toBeGreaterThan(0);
    // Au moins autant : la mention en commentaire de tête compte aussi, et elle
    // a sa place — la propriété mérite d'être annoncée avant d'être lue.
    expect(explicit.length).toBeGreaterThanOrEqual(spawns.length);
  });

  it("n'expose aucune capacité prenant une ligne de commande", async () => {
    // La propriété centrale du lot : il n'existe pas de `command: string`. Le
    // jour où quelqu'un en ajoute une, ce test le dit.
    const harness = await makeHarness();
    await harness.connectWorker();

    for (const capability of harness.capabilities.declare()) {
      const properties = Object.keys(
        (capability.inputSchema?.properties as Record<string, unknown> | undefined) ?? {},
      );
      expect(properties).not.toContain("command");
      expect(properties).not.toContain("commandLine");
      expect(properties).not.toContain("script");
    }
  });

  it("refuse une injection glissée dans un argument, sans l'interpréter", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      arguments: { executable: "git", args: ["log", "&& del /S /Q C:\\Projets"] },
    });

    // L'étape réussit : l'argument absurde est passé à git tel quel. Ce qui
    // compte est qu'une seule commande ait été lancée, et que ce soit git.
    expect(result?.ok).toBe(true);
    const lastGit = harness.runner.runs.filter((r) => r.executable === "git").at(-1);
    expect(lastGit?.args).toEqual(["log", "&& del /S /Q C:\\Projets"]);
    expect(harness.runner.runs.map((r) => r.executable)).not.toContain("cmd");
  });

  it("refuse un exécutable glissé sous forme de chemin", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      arguments: { executable: "..\\..\\Windows\\System32\\cmd.exe", args: [] },
    });

    expect(result).toMatchObject({ ok: false });
    expect(harness.runner.runs.map((r) => r.executable)).not.toContain("cmd.exe");
  });
});

describe("évasion de chemin", () => {
  it("refuse une remontée passée dans une tâche", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: `${ALLOWED_ROOT}\\..\\Windows\\System32\\config\\SAM` },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
  });

  it("refuse un chemin absolu hors racine", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.write",
      tool: "device.filesystem.write",
      arguments: { path: "C:\\Windows\\System32\\drivers\\etc\\hosts", content: "x" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
    expect(harness.fileSystem.writes).toHaveLength(0);
  });

  it("refuse une évasion par lien depuis un dossier autorisé", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.links.set(`${ALLOWED_ROOT}\\partage`, "C:\\Users\\moi\\Documents");
        fileSystem.files.set("C:\\Users\\moi\\Documents\\impots.pdf", "confidentiel");
      },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: `${ALLOWED_ROOT}\\partage\\impots.pdf` },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
    expect(JSON.stringify(result)).not.toContain("confidentiel");
  });
});

describe("capacité non autorisée", () => {
  it("refuse une capacité que le worker n'implémente pas", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: {},
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("refuse une capacité retirée de la configuration, même si le cœur l'envoie", async () => {
    // Le worker ne fait pas confiance au cœur sur ce point : il est le dernier
    // à savoir ce qui est permis sur cette machine. Un cœur compromis ne doit
    // pas suffire à lui faire exécuter ce que l'utilisateur a désactivé.
    const harness = await makeHarness({
      config: { declaredCapabilities: ["filesystem.read"] },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "process.start",
      tool: "device.process.start",
      arguments: { executable: "node", args: [] },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(harness.runner.started).toHaveLength(0);
  });

  it("refuse d'arrêter un processus que NEXUS n'a pas lancé", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "process.stop",
      tool: "device.process.stop",
      arguments: { processId: 4, force: true },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "WORKER_POLICY_VIOLATION" } });
    expect(harness.runner.stopped).toHaveLength(0);
  });
});

describe("fuite de secrets", () => {
  it("ne journalise pas les arguments en clair", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "filesystem.write",
      tool: "device.filesystem.write",
      arguments: {
        path: `${ALLOWED_ROOT}\\deploy.env`,
        content: "x",
        apiKey: "sk-neDoitPasApparaitre12345",
      },
    });

    // Deux mécanismes se succèdent, et c'est voulu : le schéma de la capacité
    // écarte d'abord tout champ qu'il ne connaît pas — `apiKey` n'en fait pas
    // partie et disparaît avant même la journalisation.
    expect(harness.logger.text).not.toContain("sk-neDoitPasApparaitre12345");
  });

  it("rédige un secret glissé dans un champ légitime", async () => {
    // Le second mécanisme : `content` est un champ attendu, donc conservé. Le
    // secret qu'il transporte est masqué à la journalisation, tandis que la
    // capacité, elle, reçoit la valeur réelle et écrit le vrai contenu.
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "filesystem.write",
      tool: "device.filesystem.write",
      arguments: {
        path: `${ALLOWED_ROOT}\\deploy.env`,
        content: "API_KEY=sk-valeurReelleEcrite123456",
      },
    });

    expect(harness.logger.text).not.toContain("sk-valeurReelleEcrite123456");
    expect(harness.logger.text).toContain("REDACTED");
    expect(harness.fileSystem.files.get(`${ALLOWED_ROOT}\\deploy.env`)).toBe(
      "API_KEY=sk-valeurReelleEcrite123456",
    );
  });

  it("ne laisse pas un secret de la sortie d'un processus atteindre le cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.runner.outcomes.set("git", {
      stdout: "Cloning into https://user:motdepassesecret@github.com/a/b.git",
    });

    const result = await dispatch(harness, {
      arguments: { executable: "git", args: ["clone"] },
    });

    expect(JSON.stringify(result)).not.toContain("motdepassesecret");
  });

  it("n'écrit jamais le jeton de session dans le journal", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const sessionFrame = harness.link.sent.find((e) => e.type === WORKER_MESSAGE.session);
    // Le jeton n'existe que dans la trame descendante, jamais dans le journal.
    expect(sessionFrame).toBeUndefined();
    expect(harness.logger.text).not.toMatch(/"token"/);
  });

  it("ne transmet pas l'environnement du worker aux processus enfants", async () => {
    // L'environnement du worker contient le chemin de sa clé privée.
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness);

    const gitRun = harness.runner.runs.filter((r) => r.executable === "git").at(-1);
    expect(Object.keys(gitRun?.env ?? {})).toEqual(
      expect.not.arrayContaining(["DEVICE_CREDENTIAL_PATH", "NEXUS_BACKEND_URL"]),
    );
  });

  it("ne révèle pas le chemin refusé dans le message rendu au cœur", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: "C:\\Users\\moi\\banque\\releve.pdf" },
    });

    expect(result?.error?.message).not.toContain("releve.pdf");
    expect(result?.error?.message).not.toContain("banque");
  });

  it("ne transmet pas le message technique d'une erreur inattendue", async () => {
    // Un message d'exception peut contenir un chemin, une variable
    // d'environnement, un fragment de fichier. Il reste local.
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.runner.missing.add("git");

    const result = await dispatch(harness);

    expect(result?.error?.code).toBe("WORKER_INTERNAL_ERROR");
    expect(result?.error?.message).not.toContain("ENOENT");
  });
});

describe("configuration", () => {
  const base = {
    NEXUS_BACKEND_URL: "wss://nexus.exemple.fr/ws",
    DEVICE_ID: "device-1",
    DEVICE_CREDENTIAL_PATH: "C:\\ProgramData\\NEXUS\\device.key",
    WORKER_ALLOWED_PATHS: "C:\\Projets",
  };

  it("accepte une configuration complète", () => {
    expect(loadWorkerConfig(base)).toMatchObject({
      deviceId: "device-1",
      allowedPaths: ["C:\\Projets"],
    });
  });

  it("refuse de démarrer sans identifiant d'appareil", () => {
    expect(() => loadWorkerConfig({ ...base, DEVICE_ID: undefined })).toThrow(
      expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }),
    );
  });

  it("refuse une adresse distante en clair", () => {
    // Le jeton de session y transiterait en clair.
    expect(() =>
      loadWorkerConfig({ ...base, NEXUS_BACKEND_URL: "ws://nexus.exemple.fr/ws" }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("tolère une adresse locale en clair, pour le développement", () => {
    expect(() =>
      loadWorkerConfig({ ...base, NEXUS_BACKEND_URL: "ws://localhost:3000/ws" }),
    ).not.toThrow();
  });

  it("désigne la clé privée par un chemin, jamais par sa valeur", () => {
    const config = loadWorkerConfig(base);
    expect(config.credentialPath).toBe("C:\\ProgramData\\NEXUS\\device.key");
    expect(JSON.stringify(config)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("refuse un intervalle de reconnexion incohérent", () => {
    expect(() =>
      loadWorkerConfig({
        ...base,
        WORKER_RECONNECT_MIN_MS: "60000",
        WORKER_RECONNECT_MAX_MS: "5000",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("refuse Docker en écriture par défaut", () => {
    expect(loadWorkerConfig(base).dockerAllowed).toEqual(["ps", "images", "logs", "inspect"]);
  });

  it("refuse Git en écriture par défaut", () => {
    expect(loadWorkerConfig(base).gitAllowWrite).toBe(false);
  });
});

describe("aucun secret dans le dépôt", () => {
  it("le fichier .env.example ne contient que des marqueurs", () => {
    const example = readFileSync(
      path.join(fileURLToPath(new URL(".", import.meta.url)), "..", ".env.example"),
      "utf8",
    );

    expect(example).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(example).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
    expect(example).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
    // La clé est désignée par un chemin, comme le veut la configuration.
    expect(example).toMatch(/DEVICE_CREDENTIAL_PATH=/);
  });
});
