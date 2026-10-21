import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOSED_POLICY,
  DevicePolicyFileError,
  checkExecutable,
  checkPath,
  describePolicy,
  devicePolicySchema,
  expandPath,
  loadDevicePolicy,
} from "../src/index.js";

/**
 * Une politique est une liste de **refus**. Chaque règle est donc attaquée, et
 * non seulement exercée : ce qui compte n'est pas qu'elle laisse passer ce
 * qu'elle doit, mais qu'elle ne laisse pas passer ce qu'elle ne doit pas.
 */

const HOME = "/srv/nexus-user";

function policy(overrides: Record<string, unknown> = {}) {
  return devicePolicySchema.parse({
    version: 1,
    filesystem: {
      allow: ["~/projets", "~/Documents/nexus"],
      deny: { under: ["~/.ssh", "~/.aws"], segments: ["node_modules"], names: [".env*"] },
    },
    ...overrides,
  });
}

describe("par défaut, tout est fermé", () => {
  it("n'autorise aucun chemin sans racine déclarée", () => {
    const decision = checkPath(CLOSED_POLICY, "/srv/nexus-user/projets/a.txt", HOME);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("aucune racine");
  });

  it("refuse une clé inconnue au lieu de l'ignorer", () => {
    // Une section muette parce qu'elle est mal orthographiée serait exactement
    // la panne silencieuse que ce format existe pour éviter.
    const parsed = devicePolicySchema.safeParse({ version: 1, filesysteme: { allow: ["/"] } });
    expect(parsed.success).toBe(false);
  });

  it("refuse une version inconnue", () => {
    expect(devicePolicySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe("chemins", () => {
  it("autorise sous une racine déclarée", () => {
    expect(checkPath(policy(), "~/projets/nexus/README.md", HOME).allowed).toBe(true);
    expect(checkPath(policy(), "/srv/nexus-user/projets", HOME).allowed).toBe(true);
  });

  it("refuse hors des racines", () => {
    expect(checkPath(policy(), "/etc/passwd", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/autre", HOME).allowed).toBe(false);
  });

  it("ne se laisse pas prendre à un préfixe de chaîne", () => {
    // `/srv/nexus-user/projets2` commence par `/srv/nexus-user/projets` sans être
    // dedans. Un refus qui comparerait des chaînes protégerait le mauvais
    // dossier — et une autorisation qui le ferait en ouvrirait un de trop.
    expect(checkPath(policy(), "/srv/nexus-user/projets2/secret", HOME).allowed).toBe(false);
  });

  it("le refus gagne, même sous une racine autorisée", () => {
    const withSshInside = devicePolicySchema.parse({
      version: 1,
      filesystem: { allow: ["~"], deny: { under: ["~/.ssh"] } },
    });
    // C'est le cas d'usage central : autoriser large, exclure précisément.
    expect(checkPath(withSshInside, "~/un-fichier", HOME).allowed).toBe(true);
    const refused = checkPath(withSshInside, "~/.ssh/id_ed25519", HOME);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("~/.ssh");
  });

  it("refuse un segment où qu'il soit dans le chemin", () => {
    const refused = checkPath(policy(), "~/projets/app/node_modules/paquet/index.js", HOME);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("node_modules");
    // Un dossier qui *contient* le mot sans être ce segment reste autorisé.
    expect(checkPath(policy(), "~/projets/node_modules_doc/notes.md", HOME).allowed).toBe(true);
  });

  it("refuse un nom avec une étoile finale", () => {
    expect(checkPath(policy(), "~/projets/.env", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/projets/.env.local", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/projets/environnement.md", HOME).allowed).toBe(true);
  });

  it("refuse un nom exact sans étoile", () => {
    const exact = devicePolicySchema.parse({
      version: 1,
      filesystem: { allow: ["~"], deny: { names: ["id_rsa"] } },
    });
    expect(checkPath(exact, "~/id_rsa", HOME).allowed).toBe(false);
    expect(checkPath(exact, "~/id_rsa.pub", HOME).allowed).toBe(true);
  });

  it("refuse une étoile ailleurs qu'en fin de nom", () => {
    // Une seule étoile, en fin : assez pour les cas réels, et la règle reste
    // lisible d'un coup d'œil.
    for (const bad of ["*.env", "a*b", "**"]) {
      const parsed = devicePolicySchema.safeParse({
        version: 1,
        filesystem: { deny: { names: [bad] } },
      });
      expect(parsed.success, bad).toBe(false);
    }
  });

  it("refuse sans tenir compte de la casse", () => {
    // Un refus trop large coûte un message d'erreur lisible ; un refus qui
    // manque coûte un secret. Et cela aligne la réponse de `nexus policy
    // check` sur celle du worker Windows, dont le système de fichiers ignore
    // la casse.
    expect(checkPath(policy(), "~/projets/.ENV", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/projets/NODE_MODULES/x", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/.SSH/id_ed25519", HOME).allowed).toBe(false);
  });

  it("étend le tilde", () => {
    expect(expandPath("~/x", HOME)).toBe("/srv/nexus-user/x");
    expect(expandPath("~", HOME)).toBe(HOME);
    expect(expandPath("/absolu", HOME)).toBe("/absolu");
  });

  it("n'est pas trompé par un chemin relatif remontant", () => {
    // `..` est normalisé avant toute comparaison : sans cela, un chemin
    // autorisé pourrait sortir de sa racine.
    expect(checkPath(policy(), "/srv/nexus-user/projets/../.ssh/id_ed25519", HOME).allowed).toBe(
      false,
    );
  });
});

describe("exécution", () => {
  it("délègue à la liste du worker quand elle n'est pas précisée", () => {
    expect(checkExecutable(policy(), "git").allowed).toBe(true);
  });

  it("refuse hors de la liste quand elle est précisée", () => {
    const restricted = devicePolicySchema.parse({
      version: 1,
      exec: { allowedExecutables: ["git", "node"] },
    });
    expect(checkExecutable(restricted, "git").allowed).toBe(true);
    expect(checkExecutable(restricted, "GIT").allowed).toBe(true);
    expect(checkExecutable(restricted, "curl").allowed).toBe(false);
  });

  it("le mode désactivé coupe tout, liste ou pas", () => {
    const disabled = devicePolicySchema.parse({
      version: 1,
      exec: { mode: "disabled", allowedExecutables: ["git"] },
    });
    expect(checkExecutable(disabled, "git").allowed).toBe(false);
  });

  it("n'a pas de mode « confirm-all »", () => {
    // Une confirmation est une décision humaine, prise sur la surface où la
    // personne se trouve — pas sur une machine qui n'a pas d'écran.
    expect(
      devicePolicySchema.safeParse({ version: 1, exec: { mode: "confirm-all" } }).success,
    ).toBe(false);
  });
});

describe("lecture du fichier", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-policy-"));
    path = join(directory, "device-policy.yaml");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("rend la politique fermée quand le fichier n'existe pas", async () => {
    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("défaut");
    expect(loaded.policy).toEqual(CLOSED_POLICY);
  });

  it("lit un fichier valide", async () => {
    await writeFile(
      path,
      [
        "version: 1",
        "filesystem:",
        "  allow:",
        "    - ~/projets",
        "git:",
        "  allowWrite: true",
      ].join("\n"),
    );
    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("fichier");
    expect(loaded.policy.filesystem.allow).toEqual(["~/projets"]);
    expect(loaded.policy.git.allowWrite).toBe(true);
    // Ce qui n'est pas écrit garde sa valeur par défaut, et elle est fermée.
    expect(loaded.policy.network.egress).toBe("deny");
  });

  it("refuse un fichier invalide au lieu de retomber sur les défauts", async () => {
    // Quelqu'un a écrit une politique. L'ignorer pour cause de virgule
    // manquante appliquerait l'inverse de son intention, sans le dire.
    await writeFile(path, "version: 1\nfilesystem:\n  allow: pas-une-liste\n");
    const error = await loadDevicePolicy(path).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DevicePolicyFileError);
    expect((error as DevicePolicyFileError).problems.join(" ")).toContain("filesystem.allow");
  });

  it("nomme la ligne fautive d'un YAML cassé", async () => {
    await writeFile(path, "version: 1\nfilesystem:\n  allow: [a, b\n");
    const error = await loadDevicePolicy(path).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DevicePolicyFileError);
    expect((error as DevicePolicyFileError).problems[0]).toContain("YAML");
  });
});

describe("affichage", () => {
  it("rend toute la politique, pas la moitié", () => {
    // Une politique affichée à moitié laisserait croire que ce qui n'apparaît
    // pas n'existe pas.
    const text = describePolicy({ policy: policy(), source: "fichier", path: "/tmp/p.yaml" });
    for (const expected of [
      "racines autorisées",
      "refusé sous",
      "segments refusés",
      "noms refusés",
      "taille maximale",
      "mode",
      "exécutables",
      "environnement",
      "écriture git",
      "docker",
      "réseau sortant",
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toContain("/tmp/p.yaml");
  });

  it("dit quand une liste est vide, au lieu de ne rien dire", () => {
    const text = describePolicy({ policy: CLOSED_POLICY, source: "défaut", path: undefined });
    expect(text).toContain("aucune — tout est refusé");
  });
});
