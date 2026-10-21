import { describe, expect, it } from "vitest";
import { devicePolicySchema } from "@nexus/device-policy";
import { assembleCapabilities } from "../src/assemble.js";
import { PathPolicy } from "../src/policy/path-policy.js";
import { testConfig } from "./fixtures.js";

/**
 * La politique locale est-elle **appliquée** ?
 *
 * Une politique qu'on peut éditer et interroger, mais que le worker n'applique
 * pas, est plus dangereuse que pas de politique : elle a l'air appliquée. Ces
 * tests passent donc par `assembleCapabilities`, c'est-à-dire par le chemin
 * réel du démon, et vérifient les refus sur la politique de chemins qui en
 * sort.
 */

const policy = (overrides: Record<string, unknown>) =>
  devicePolicySchema.parse({ version: 1, ...overrides });

/** Ce que le worker annonce réellement au cœur. */
const advertised = (assembled: ReturnType<typeof assembleCapabilities>): string[] =>
  assembled.capabilities.declare().map((capability) => capability.name);

describe("refus configurables sur les chemins", () => {
  const base = {
    allowedRoots: ["C:\\Projets"],
    realpath: (candidate: string) => Promise.resolve(candidate),
  };

  it("refuse un segment déclaré par la politique", async () => {
    const strict = new PathPolicy({ ...base, deniedSegments: ["clients"] });
    await expect(strict.resolve("C:\\Projets\\clients\\contrat.md")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\app\\index.ts")).resolves.toContain("index.ts");
  });

  it("refuse un nom déclaré, avec étoile finale", async () => {
    const strict = new PathPolicy({ ...base, deniedNames: [".env*"] });
    // C'est le cas que les refus par dossier ne couvrent pas : un `.env` traîne
    // dans chaque projet, sous une racine qu'on veut par ailleurs autoriser.
    await expect(strict.resolve("C:\\Projets\\app\\.env")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\app\\.env.local")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\app\\environnement.md")).resolves.toBeTruthy();
  });

  it("ignore la casse, comme le système de fichiers", async () => {
    const strict = new PathPolicy({ ...base, deniedNames: [".env*"], deniedSegments: ["clients"] });
    await expect(strict.resolve("C:\\Projets\\app\\.ENV")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\CLIENTS\\x")).rejects.toThrow();
  });

  it("n'ouvre jamais ce que le worker refuse de lui-même", async () => {
    // Une politique locale peut fermer davantage, jamais ouvrir : les refus
    // intégrés restent, quelle que soit la politique.
    const permissive = new PathPolicy({ allowedRoots: ["C:\\"], realpath: base.realpath });
    await expect(permissive.resolve("C:\\Users\\moi\\.ssh\\id_ed25519")).rejects.toThrow();
    await expect(permissive.resolve("C:\\Windows\\System32\\config\\SAM")).rejects.toThrow();
  });
});

describe("assemblage du démon", () => {
  it("sans politique, se règle sur l'environnement — rien ne change", () => {
    const assembled = assembleCapabilities({ config: testConfig() });
    expect(assembled.pathPolicy.roots.length).toBeGreaterThan(0);
    expect(advertised(assembled)).toContain("terminal.execute");
  });

  it("avec une politique, ce sont ses racines qui s'appliquent", async () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({ filesystem: { allow: ["C:\\Autorise"] } }),
    });
    // Les racines de l'environnement ne sont plus en vigueur : il ne peut pas y
    // avoir deux sources de vérité sur ce qu'une machine autorise.
    expect(assembled.pathPolicy.roots.some((root) => root.includes("Autorise"))).toBe(true);
    await expect(assembled.pathPolicy.resolve("C:\\Autorise\\x.txt")).resolves.toBeTruthy();
  });

  it("ses refus s'appliquent sous une racine autorisée", async () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({
        filesystem: { allow: ["C:\\Autorise"], deny: { names: ["secret*"] } },
      }),
    });
    await expect(assembled.pathPolicy.resolve("C:\\Autorise\\secret.txt")).rejects.toThrow();
  });

  it("exec désactivé ne déclare pas les capacités d'exécution", () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({ exec: { mode: "disabled" } }),
    });
    // Le cœur doit savoir que cette machine ne peut pas exécuter, plutôt que de
    // lui envoyer des tâches qu'elle refusera une par une — ce qui
    // ressemblerait à une panne.
    // `declare()` est exactement ce que le worker annonce au cœur.
    const names = advertised(assembled);
    expect(names).not.toContain("terminal.execute");
    expect(names).not.toContain("process.start");
    expect(names).toContain("filesystem.read");
  });

  it("la politique décide de git et de docker", () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({
        git: { allowWrite: true },
        docker: { allowedSubcommands: ["ps"] },
      }),
    });
    expect(assembled.gitPolicy.allowsWrite).toBe(true);
    expect(assembled.dockerPolicy.allowedSubcommands).toEqual(["ps"]);
  });
});
