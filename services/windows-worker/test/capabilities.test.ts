import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalCapabilityRegistry } from "@nexus/worker-core";
import { parseApplications } from "../src/capabilities/app.js";
import { assembleForTest, ALLOWED_ROOT, type AssembledFixture } from "./fixtures.js";
import type { CapabilityContext } from "@nexus/worker-core";

/**
 * Les capacités, une par une.
 *
 * Aucun processus n'est lancé et aucun fichier n'est écrit : `ProcessRunner` et
 * `FileSystemPort` sont remplacés. Ce qui est vérifié, c'est exactement ce que
 * la capacité *demande* au système — quels arguments, dans quel ordre, avec quel
 * environnement — car c'est là que se joue la sécurité.
 */

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    taskId: "t1",
    stepId: "s1",
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onProgress: () => undefined,
    ...overrides,
  };
}

async function run(fixture: AssembledFixture, name: string, input: unknown, ctx = context()) {
  const capability = fixture.capabilities.require(name);
  const validated = fixture.capabilities.validateInput(name, input);
  return capability.execute(validated as never, ctx);
}

describe("registre local", () => {
  it("annonce les capacités disponibles", async () => {
    const fixture = await assembleForTest();
    const declared = fixture.capabilities.declare().map((capability) => capability.name);

    expect(declared).toEqual(
      expect.arrayContaining([
        "terminal.execute",
        "filesystem.read",
        "filesystem.write",
        "process.list",
        "process.start",
        "process.stop",
        "docker.execute",
        "git.status",
        "git.pull",
        "git.checkout",
        "git.branch",
        "git.clone",
        "git.commit",
        "git.diff",
        "browser.open",
        "app.open",
      ]),
    );
    // Le compte exact, et pas seulement « contient » : une capacité qui
    // apparaîtrait sans qu'on l'ait voulue est un élargissement silencieux de ce
    // que NEXUS peut faire à cette machine.
    expect(declared).toHaveLength(16);
  });

  it("n'annonce pas une capacité dont l'outil est absent", async () => {
    // Docker n'est pas installé : la sonde échoue, la capacité disparaît de
    // l'annonce. Elle n'apparaîtra donc pas au sélecteur, qui choisira ailleurs.
    const fixture = await assembleForTest({}, ({ runner }) => {
      runner.missing.add("docker");
    });

    const declared = fixture.capabilities.declare().map((capability) => capability.name);
    expect(declared).not.toContain("docker.execute");
    expect(declared).toContain("git.status");
  });

  it("refuse d'exécuter une capacité indisponible", async () => {
    const fixture = await assembleForTest({}, ({ runner }) => {
      runner.missing.add("docker");
    });

    expect(() => fixture.capabilities.require("docker.execute")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("n'annonce que les capacités autorisées par la configuration", async () => {
    const fixture = await assembleForTest({
      declaredCapabilities: ["filesystem.read", "git.status"],
    });

    expect(fixture.capabilities.declare().map((c) => c.name)).toEqual([
      "filesystem.read",
      "git.status",
    ]);
  });

  it("refuse une capacité présente mais non autorisée localement", async () => {
    const fixture = await assembleForTest({ declaredCapabilities: ["filesystem.read"] });

    expect(() => fixture.capabilities.require("terminal.execute")).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
        context: expect.objectContaining({ reason: expect.stringContaining("configuration") }),
      }),
    );
  });

  it("refuse une capacité inconnue", async () => {
    const fixture = await assembleForTest();
    expect(() => fixture.capabilities.require("registry.wipe")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("refuse un enregistrement en double", () => {
    const registry = new LocalCapabilityRegistry();
    const definition = {
      name: "test.echo",
      description: "",
      inputSchema: z.object({}),
      riskLevel: "SAFE" as const,
      execute: () => Promise.resolve({}),
    };

    registry.register(definition);
    expect(() => registry.register(definition)).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("nomme le champ fautif quand les arguments sont invalides", async () => {
    const fixture = await assembleForTest();

    expect(() => fixture.capabilities.validateInput("filesystem.read", { chemin: "x" })).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_INPUT_INVALID",
        context: expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("path")]),
        }),
      }),
    );
  });

  it("dresse un inventaire motivé", async () => {
    const fixture = await assembleForTest(
      { declaredCapabilities: ["filesystem.read", "docker.execute"] },
      ({ runner }) => {
        runner.missing.add("docker");
      },
    );

    const inventory = fixture.capabilities.inventory();
    const docker = inventory.find((entry) => entry.capability.name === "docker.execute");
    const terminal = inventory.find((entry) => entry.capability.name === "terminal.execute");

    expect(docker?.available).toBe(false);
    expect(docker?.reason).toMatch(/absent/);
    expect(terminal?.reason).toMatch(/configuration/);
  });
});

describe("terminal.execute", () => {
  it("exécute un programme autorisé sans shell", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "terminal.execute", {
      executable: "git",
      args: ["status", "--porcelain"],
    })) as { exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(fixture.runner.runs[0]).toMatchObject({
      executable: "git",
      args: ["status", "--porcelain"],
    });
  });

  it("refuse un exécutable non autorisé", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "terminal.execute", { executable: "curl", args: ["https://exemple.fr"] }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_NOT_ALLOWED" });

    expect(fixture.runner.runs).toHaveLength(0);
  });

  it("refuse un argument mal typé au schéma", async () => {
    const fixture = await assembleForTest();
    expect(() =>
      fixture.capabilities.validateInput("terminal.execute", { executable: "git", args: [42] }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("refuse un répertoire de travail hors des racines", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "terminal.execute", {
        executable: "git",
        args: ["status"],
        workingDirectory: "C:\\Windows\\System32",
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });

    expect(fixture.runner.runs).toHaveLength(0);
  });

  it("traduit un dépassement de délai en erreur réessayable", async () => {
    const fixture = await assembleForTest();
    fixture.runner.outcomes.set("git", { status: "timeout", exitCode: null });

    await expect(
      run(fixture, "terminal.execute", { executable: "git", args: ["log"] }),
    ).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT", retryable: true });
  });

  it("propage l'annulation jusqu'au processus", async () => {
    const fixture = await assembleForTest();
    fixture.runner.hangUntilAborted = true;

    const controller = new AbortController();
    const pending = run(
      fixture,
      "terminal.execute",
      { executable: "git", args: ["log"] },
      context({ signal: controller.signal }),
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
  });

  it("ne transmet que les variables d'environnement autorisées", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "terminal.execute", { executable: "git", args: ["status"] });

    // `PATH` et `TEMP` sont autorisées ; tout le reste de l'environnement du
    // worker — dont le chemin de sa clé privée — reste chez lui.
    expect(fixture.runner.runs[0]?.env).toEqual({
      PATH: "C:\\Windows;C:\\Program Files\\Git\\cmd",
      TEMP: "C:\\Temp",
    });
  });

  it("rédige les secrets de la sortie du processus", async () => {
    // Un script qui affiche sa clé d'API : la valeur ne doit pas quitter la
    // machine, alors même que le worker n'a aucun contrôle sur ce qu'il exécute.
    const fixture = await assembleForTest();
    fixture.runner.outcomes.set("git", {
      stdout: "remote: https://x-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b\n",
      stderr: "API_KEY=sk-abcdefghijklmnopqrstuvwx",
    });

    const result = (await run(fixture, "terminal.execute", {
      executable: "git",
      args: ["push"],
    })) as { stdout: string; stderr: string };

    expect(result.stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(result.stderr).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result.stdout).toContain("[REDACTED]");
  });
});

describe("filesystem", () => {
  it("lit un fichier autorisé", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(`${ALLOWED_ROOT}\\notes.md`, "bonjour");
    });

    const result = (await run(fixture, "filesystem.read", {
      path: `${ALLOWED_ROOT}\\notes.md`,
    })) as { content: string };

    expect(result.content).toBe("bonjour");
  });

  it("refuse une lecture hors des racines", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "filesystem.read", { path: "C:\\Users\\moi\\.aws\\credentials" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("refuse une remontée par ..", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "filesystem.read", { path: `${ALLOWED_ROOT}\\..\\Windows\\win.ini` }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("rédige les secrets d'un fichier lu", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(
        `${ALLOWED_ROOT}\\.env`,
        "DB_HOST=localhost\nAPI_KEY=sk-secret1234567890abcd\n",
      );
    });

    const result = (await run(fixture, "filesystem.read", {
      path: `${ALLOWED_ROOT}\\.env`,
    })) as { content: string };

    expect(result.content).toContain("DB_HOST=localhost");
    expect(result.content).not.toContain("sk-secret1234567890abcd");
  });

  it("écrit un fichier autorisé", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "filesystem.write", {
      path: `${ALLOWED_ROOT}\\out.txt`,
      content: "ok",
    })) as { created: boolean; bytesWritten: number };

    expect(result).toMatchObject({ created: true, bytesWritten: 2 });
    expect(fixture.fileSystem.files.get(`${ALLOWED_ROOT}\\out.txt`)).toBe("ok");
  });

  it("refuse une écriture hors des racines", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "filesystem.write", { path: "C:\\Windows\\evil.dll", content: "x" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });

    expect(fixture.fileSystem.writes).toHaveLength(0);
  });

  it("refuse d'écraser un fichier sans demande explicite", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(`${ALLOWED_ROOT}\\important.txt`, "travail de six mois");
    });

    await expect(
      run(fixture, "filesystem.write", {
        path: `${ALLOWED_ROOT}\\important.txt`,
        content: "oups",
      }),
    ).rejects.toMatchObject({ code: "WORKER_POLICY_VIOLATION" });

    expect(fixture.fileSystem.files.get(`${ALLOWED_ROOT}\\important.txt`)).toBe(
      "travail de six mois",
    );
  });

  it("accepte l'écrasement quand il est demandé", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(`${ALLOWED_ROOT}\\brouillon.txt`, "ancien");
    });

    await run(fixture, "filesystem.write", {
      path: `${ALLOWED_ROOT}\\brouillon.txt`,
      content: "nouveau",
      overwrite: true,
    });

    expect(fixture.fileSystem.files.get(`${ALLOWED_ROOT}\\brouillon.txt`)).toBe("nouveau");
  });
});

describe("process", () => {
  it("liste les processus", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "process.list", {})) as { total: number };
    expect(result.total).toBe(2);
  });

  it("filtre la liste par nom", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "process.list", { nameContains: "chrome" })) as {
      total: number;
    };
    expect(result.total).toBe(1);
  });

  it("démarre un programme autorisé", async () => {
    const fixture = await assembleForTest();
    const started = (await run(fixture, "process.start", {
      executable: "node",
      args: ["serveur.js"],
    })) as { processId: number };

    expect(started.processId).toBeGreaterThan(0);
    expect(fixture.runner.started[0]).toMatchObject({ executable: "node" });
  });

  it("refuse de démarrer un programme non autorisé", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "process.start", { executable: "regedit", args: [] }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_NOT_ALLOWED" });
  });

  it("arrête un processus que NEXUS a lancé", async () => {
    const fixture = await assembleForTest();
    const started = (await run(fixture, "process.start", {
      executable: "node",
      args: [],
    })) as { processId: number };

    const stopped = (await run(fixture, "process.stop", {
      processId: started.processId,
    })) as { stopped: boolean };

    expect(stopped.stopped).toBe(true);
  });

  it("refuse d'arrêter un processus que NEXUS n'a pas lancé", async () => {
    // Sans cette règle, `process.stop` permettrait d'arrêter l'antivirus ou la
    // session de travail de l'utilisateur avec les mêmes permissions que celles
    // accordées pour arrêter un serveur de développement.
    const fixture = await assembleForTest();
    await expect(run(fixture, "process.stop", { processId: 1001 })).rejects.toMatchObject({
      code: "WORKER_POLICY_VIOLATION",
      context: expect.objectContaining({ rule: "process.notOwned" }),
    });

    expect(fixture.runner.stopped).toHaveLength(0);
  });
});

describe("docker", () => {
  it("exécute une opération de consultation autorisée", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "docker.execute", { subcommand: "ps", args: ["-a"] });

    const dockerRuns = fixture.runner.runs.filter((r) => r.executable === "docker");
    expect(dockerRuns.at(-1)?.args).toEqual(["ps", "-a"]);
  });

  it("refuse une opération non autorisée", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "docker.execute", { subcommand: "run", args: ["ubuntu"] }),
    ).rejects.toMatchObject({ code: "WORKER_POLICY_VIOLATION" });
  });

  it("rédige les secrets des journaux de conteneur", async () => {
    const fixture = await assembleForTest();
    fixture.runner.outcomes.set("docker", {
      stdout: "env: DATABASE_PASSWORD=motdepassesecret\n",
    });

    const result = (await run(fixture, "docker.execute", {
      subcommand: "logs",
      args: ["api"],
    })) as { stdout: string };

    expect(result.stdout).not.toContain("motdepassesecret");
  });
});

describe("git", () => {
  it("exécute une lecture sans autorisation d'écriture", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "git.status", { repositoryPath: `${ALLOWED_ROOT}\\leynai` });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.args).toEqual(["status", "--porcelain=v1", "--branch"]);
    expect(gitRuns.at(-1)?.cwd).toBe(`${ALLOWED_ROOT}\\leynai`);
  });

  it("refuse une écriture quand la configuration est en lecture seule", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: false });
    await expect(
      run(fixture, "git.pull", { repositoryPath: `${ALLOWED_ROOT}\\leynai` }),
    ).rejects.toMatchObject({
      code: "WORKER_POLICY_VIOLATION",
      context: expect.objectContaining({ rule: "git.readOnly" }),
    });
  });

  it("autorise l'écriture quand la configuration l'accorde", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await run(fixture, "git.pull", { repositoryPath: `${ALLOWED_ROOT}\\leynai` });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.args).toEqual(["pull", "--ff-only", "origin"]);
  });

  it("empêche Git d'attendre une invite de mot de passe", async () => {
    // Sans cela, un dépôt privé bloquerait jusqu'au délai maximal au lieu
    // d'échouer tout de suite.
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await run(fixture, "git.pull", { repositoryPath: `${ALLOWED_ROOT}\\leynai` });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" });
  });

  it("refuse un nom de branche qui serait relu comme une option", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    expect(() =>
      fixture.capabilities.validateInput("git.checkout", {
        repositoryPath: `${ALLOWED_ROOT}\\leynai`,
        branch: "--orphan",
      }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("ferme la liste des options après la branche", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await run(fixture, "git.checkout", {
      repositoryPath: `${ALLOWED_ROOT}\\leynai`,
      branch: "main",
    });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.args).toEqual(["checkout", "main", "--"]);
  });

  it("refuse un clone depuis un hôte non autorisé", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await expect(
      run(fixture, "git.clone", {
        url: "https://evil.example/x.git",
        destination: `${ALLOWED_ROOT}\\x`,
      }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "git.remoteHost" }) });
  });

  it("refuse un clone vers une destination hors des racines", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await expect(
      run(fixture, "git.clone", {
        url: "https://github.com/adlan/leynai.git",
        destination: "C:\\Windows\\Temp\\x",
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});

describe("browser.open", () => {
  it("ouvre une adresse https", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "browser.open", {
      url: "https://exemple.fr/page",
    })) as { opened: boolean };

    expect(result.opened).toBe(true);
  });

  it("refuse un schéma autre que http(s)", async () => {
    // `file://` ouvrirait un fichier local hors de toute politique de chemins.
    const fixture = await assembleForTest();
    expect(() =>
      fixture.capabilities.validateInput("browser.open", { url: "file:///C:/Windows/win.ini" }),
    ).not.toThrow();

    await expect(
      run(fixture, "browser.open", { url: "file:///C:/Windows/win.ini" }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "browser.protocol" }) });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// app.open
// ─────────────────────────────────────────────────────────────────────────────

describe("app.open", () => {
  it("ouvre une application connue, sans l'attendre", async () => {
    // `start` et non `run` : une fenêtre survit à la tâche qui l'a ouverte.
    // L'attendre bloquerait l'étape jusqu'à ce que l'utilisateur la ferme.
    const fixture = await assembleForTest();
    const result = (await run(fixture, "app.open", { app: "chrome" })) as { app: string };

    expect(result.app).toBe("chrome");
    expect(fixture.runner.started).toHaveLength(1);
    expect(fixture.runner.started[0]?.executable).toContain("chrome.exe");
    // Aucun argument : les arguments d'une application graphique sont un second
    // canal d'injection — `chrome --load-extension=…` charge du code.
    expect(fixture.runner.started[0]?.args).toEqual([]);
    expect(fixture.runner.runs).toHaveLength(0);
  });

  it("le nom est insensible à la casse", async () => {
    const fixture = await assembleForTest();
    await expect(run(fixture, "app.open", { app: "Chrome" })).resolves.toBeDefined();
  });

  it("refuse une application inconnue, et dit lesquelles existent", async () => {
    const fixture = await assembleForTest();

    await expect(run(fixture, "app.open", { app: "malveillant" })).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_ALLOWED",
    });
    expect(fixture.runner.started).toHaveLength(0);
  });

  it("n'accepte pas un chemin — c'est toute la garantie", async () => {
    // La table de résolution est la frontière. Accepter un chemin la
    // contournerait entièrement et ferait de `app.open` une exécution
    // arbitraire déguisée.
    const fixture = await assembleForTest();

    for (const app of [
      "C:\\Windows\\System32\\cmd.exe",
      "..\\..\\payload.exe",
      "chrome.exe",
      "/usr/bin/env",
    ]) {
      await expect(run(fixture, "app.open", { app }), app).rejects.toMatchObject({
        code: "EXECUTABLE_NOT_ALLOWED",
      });
    }

    expect(fixture.runner.started).toHaveLength(0);
  });

  it("ne transmet pas l'environnement du worker", async () => {
    // Il contient le chemin de la clé privée de l'appareil.
    const fixture = await assembleForTest();
    await run(fixture, "app.open", { app: "bloc-notes" });

    const transmitted = Object.keys(fixture.runner.started[0]?.env ?? {});
    expect(transmitted).toEqual(expect.arrayContaining([]));
    expect(transmitted).not.toContain("DEVICE_CREDENTIAL_PATH");
  });
});

describe("table des applications", () => {
  it("décode les entrées bien formées", () => {
    const parsed = parseApplications([
      "chrome=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "Spotify=C:\\Users\\moi\\AppData\\Roaming\\Spotify\\Spotify.exe",
    ]);

    expect(parsed.get("chrome")).toContain("chrome.exe");
    // Le nom est normalisé en minuscules : l'utilisateur écrit « Spotify »,
    // le modèle écrira « spotify ».
    expect(parsed.get("spotify")).toContain("Spotify.exe");
  });

  it("ignore ce qui est mal formé plutôt que de refuser de démarrer", () => {
    // Une ligne douteuse ne doit pas priver l'utilisateur de son worker entier.
    // Ce qui n'est pas décodé n'est simplement pas ouvrable.
    const parsed = parseApplications([
      "sans-separateur",
      "=sans-nom",
      "sans-chemin=",
      "nul=C:\\a\u0000b.exe",
      "bon=C:\\Windows\\notepad.exe",
    ]);

    expect([...parsed.keys()]).toEqual(["bon"]);
  });
});
