import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerConfigurationError } from "@nexus/worker-core";
import { describeConfig, loadBrowserHostConfig } from "../src/config.js";
import { toSocketUrl } from "../src/connection/link.js";
import { BROWSER_TOKEN, makeHarness, testConfig } from "./fixtures.js";

/**
 * Les propriétés de sécurité de l'exécutant navigateur, énoncées comme tests.
 *
 * Le navigateur est la surface la plus exposée de NEXUS : il visite du contenu
 * hostile par définition, et il le fait avec les identifiants de l'utilisateur.
 * Certaines propriétés s'observent à l'exécution ; d'autres se vérifient sur le
 * **code source**, parce que ce sont des absences — et une absence ne se
 * démontre pas en essayant une fois, mais en lisant tout.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Retire les commentaires : on juge le code, pas ce qu'il dit de lui-même. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const BASE = {
  NEXUS_BACKEND_URL: "wss://nexus.exemple.fr",
  DEVICE_ID: "device-browser",
  DEVICE_KEY_PATH: "/secrets/device.pem",
  BROWSER_WORKER_TOKEN: BROWSER_TOKEN,
};

// ─────────────────────────────────────────────────────────────────────────────
// Aucune capacité générique
// ─────────────────────────────────────────────────────────────────────────────

describe("surface d'exécution", () => {
  it("n'expose aucune exécution de commande ni accès disque", () => {
    // Un exécutant navigateur qui saurait lancer une commande transformerait
    // une page hostile en accès à la machine. Il n'y a pas de `terminal.*`, pas
    // de `filesystem.*`, et aucune capacité générique qui prendrait un nom
    // d'action en argument.
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/child_process|execSync|spawnSync|\bexec\(|ProcessBuilder/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("n'écrit ni ne lit de fichier hors de la clé de l'appareil", () => {
    // Une seule lecture de fichier existe dans tout le paquet : la clé privée,
    // dans `link.ts`. Toute autre serait une porte vers le disque de l'hôte.
    const readers: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/node:fs|writeFile|readFile|createWriteStream/.test(content)) {
        readers.push(path.relative(ROOT, file).replace(/\\/g, "/"));
      }
    }

    expect(readers).toEqual(["src/connection/link.ts"]);
  });

  it("ne déclare aucune capacité en dehors du domaine browser", async () => {
    // Ce que le cœur reçoit à l'enregistrement : rien qui sorte du navigateur.
    const harness = await makeHarness();
    await harness.connect();

    const registered = harness.link.sent.find((envelope) => envelope.type === "worker.register");
    const payload = registered?.payload as { capabilities: { name: string }[] };

    expect(payload.capabilities.length).toBeGreaterThan(0);
    for (const capability of payload.capabilities) {
      expect(capability.name.startsWith("browser.")).toBe(true);
    }
  });

  it("n'écoute sur aucun port", () => {
    // La forme du port `WorkerLink` le dit déjà — il y a `connect`, il n'y a pas
    // `listen` — mais un service qui pilote un navigateur visitant du contenu
    // hostile ne doit surtout pas être joignable.
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/\.listen\(|createServer|WebSocketServer/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentification et identité
// ─────────────────────────────────────────────────────────────────────────────

describe("authentification", () => {
  it("n'utilise aucun secret partagé avec le cœur", async () => {
    // L'authentification auprès du cœur est une signature de défi, pas un
    // jeton. Un jeton dérobé dans un journal permettrait de se faire passer
    // pour cet exécutant ; une signature exige la clé, qui ne circule jamais.
    const harness = await makeHarness();
    await harness.connect();

    const authenticate = harness.link.sent.find(
      (envelope) => envelope.type === "worker.authenticate",
    );
    const payload = authenticate?.payload as { signature?: string; nonce?: string };

    expect(payload.signature).toBeTruthy();
    expect(JSON.stringify(harness.link.sent)).not.toContain(BROWSER_TOKEN);
  });

  it("ne transmet jamais le jeton du worker Python au cœur", async () => {
    // Deux liens, deux secrets, aucun ne franchit la frontière de l'autre.
    const harness = await makeHarness();
    await harness.connect();

    expect(JSON.stringify(harness.link.sent)).not.toContain("Bearer");
    expect(JSON.stringify(harness.link.sent)).not.toContain(BROWSER_TOKEN);
  });

  it("exige un jeton de service d'une longueur réelle", () => {
    expect(() => loadBrowserHostConfig({ ...BASE, BROWSER_WORKER_TOKEN: "court" })).toThrow(
      WorkerConfigurationError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

describe("secrets", () => {
  it("le diagnostic ne rend aucune valeur secrète", () => {
    const description = describeConfig(
      testConfig({ browserWorkerToken: "un-jeton-tres-secret-et-long" }),
    );
    const serialised = JSON.stringify(description);

    expect(serialised).not.toContain("un-jeton-tres-secret-et-long");
    expect(serialised).not.toContain("/inexistant/device.pem");
    expect(description.browserWorkerToken).toBe("[défini]");
  });

  it("aucun secret n'est codé dans les sources", () => {
    // Le fichier d'exemple liste les clés, jamais les valeurs.
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
      expect(content).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });

  it("le chemin de la clé ne figure jamais dans un message d'erreur", () => {
    const description = describeConfig(testConfig());
    expect(Object.values(description)).not.toContain("/inexistant/device.pem");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Réseau
// ─────────────────────────────────────────────────────────────────────────────

describe("réseau", () => {
  it("refuse une liaison distante en clair vers le cœur", () => {
    expect(() =>
      loadBrowserHostConfig({ ...BASE, NEXUS_BACKEND_URL: "http://nexus.exemple.fr" }),
    ).toThrow(WorkerConfigurationError);
    expect(() => toSocketUrl("ws://nexus.exemple.fr", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });

  it("tolère la boucle locale, où rien ne sort de la machine", () => {
    expect(toSocketUrl("http://localhost:3000", "/ws/worker")).toBe(
      "ws://localhost:3000/ws/worker",
    );
  });

  it("refuse une adresse publique en clair pour le worker Python", () => {
    // Ce worker ne doit jamais être exposé à Internet. Si son adresse est
    // publique, elle doit au minimum être chiffrée — et le README dit qu'elle
    // ne devrait pas être publique du tout.
    expect(() =>
      loadBrowserHostConfig({ ...BASE, BROWSER_WORKER_URL: "http://browser.exemple.fr" }),
    ).toThrow(WorkerConfigurationError);
  });

  it("accepte un nom de service interne", () => {
    // `browser-worker` sans point : un nom de service Docker, pas un domaine.
    const config = loadBrowserHostConfig({
      ...BASE,
      BROWSER_WORKER_URL: "http://browser-worker:8100",
    });
    expect(config.browserWorkerUrl).toBe("http://browser-worker:8100");
  });

  it("refuse un protocole exotique", () => {
    expect(() => toSocketUrl("file:///etc/passwd", "/ws/worker")).toThrow(WorkerConfigurationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Politique : elle n'est pas ici, et c'est voulu
// ─────────────────────────────────────────────────────────────────────────────

describe("politique de navigation", () => {
  it("n'est pas réimplémentée dans l'hôte", () => {
    // La restriction des actions par intention appartient au worker Python
    // (`policies.py`). Deux politiques finissent par diverger, et c'est la plus
    // permissive qui gagne. L'hôte transmet l'intention ; il ne la réinterprète
    // pas.
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/EXCLUDED_ACTIONS|excludedActions|ALWAYS_EXCLUDED|isDomainAllowed/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("transmet l'intention telle qu'elle, sans la reclasser", async () => {
    // Un achat reste un achat jusqu'au navigateur. Rétrograder l'intention en
    // chemin ferait sauter la restriction d'actions du worker Python.
    const harness = await makeHarness();
    await harness.connect();

    const { assembleBrowserHost } = await import("../src/assemble.js");
    const { capabilities } = assembleBrowserHost({
      config: testConfig(),
      client: harness.client,
    });

    await capabilities.require("browser.purchase").execute({ instructions: "achète" } as never, {
      taskId: "t",
      stepId: "s",
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      onProgress: () => undefined,
    });

    expect(harness.python.launched.at(-1)?.intent).toBe("purchase");
  });
});
