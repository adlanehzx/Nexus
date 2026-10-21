import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDevicePolicy } from "@nexus/device-policy";
import { POLICY_EXAMPLE, defaultPolicyPath, policyCommand } from "../src/policy.js";

/**
 * `nexus policy`.
 *
 * Le test qui compte est le premier : l'exemple produit par `init` doit être
 * **valide**. La première version ne l'était pas — une liste dont toutes les
 * entrées sont commentées vaut `null` et non `[]` — et seul le fait de lancer
 * la commande l'a montré.
 */

describe("l'exemple livré", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-cli-policy-"));
    path = join(directory, "device-policy.yaml");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("se relit sans erreur", async () => {
    await writeFile(path, POLICY_EXAMPLE);
    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("fichier");
  });

  it("ne donne aucun accès tant qu'on ne l'a pas édité", async () => {
    await writeFile(path, POLICY_EXAMPLE);
    const { policy } = await loadDevicePolicy(path);
    // Un exemple qui ouvrirait le dossier personnel serait recopié tel quel.
    expect(policy.filesystem.allow).toEqual([]);
  });

  it("refuse déjà les endroits qui comptent", async () => {
    await writeFile(path, POLICY_EXAMPLE);
    const { policy } = await loadDevicePolicy(path);
    expect(policy.filesystem.deny.under).toContain("~/.ssh");
    expect(policy.filesystem.deny.names).toContain(".env*");
    expect(policy.filesystem.deny.segments).toContain("node_modules");
    expect(policy.network.egress).toBe("deny");
    expect(policy.git.allowWrite).toBe(false);
  });

  it("init écrit le fichier et refuse d'écraser sans --force", async () => {
    expect(await policyCommand(["init", "--file", path])).toBe(0);
    const first = await readFile(path, "utf8");
    expect(first).toBe(POLICY_EXAMPLE);

    await writeFile(path, `${POLICY_EXAMPLE}# édité à la main\n`);
    // Ce fichier est la seule défense locale : le réinitialiser par mégarde
    // remplacerait une politique réfléchie par un exemple.
    expect(await policyCommand(["init", "--file", path])).toBe(1);
    expect(await readFile(path, "utf8")).toContain("édité à la main");

    expect(await policyCommand(["init", "--file", path, "--force"])).toBe(0);
    expect(await readFile(path, "utf8")).not.toContain("édité à la main");
  });

  it("check rend 2 sur un refus, 0 sur une autorisation", async () => {
    await writeFile(
      path,
      [
        "version: 1",
        "filesystem:",
        "  allow:",
        "    - /tmp",
        "  deny:",
        "    under:",
        "      - /tmp/interdit",
      ].join("\n"),
    );
    // Un refus n'est pas une erreur de la commande : on a posé une question et
    // obtenu une réponse. Le code reflète la réponse, ce qui rend la commande
    // utilisable dans un script de vérification.
    expect(await policyCommand(["check", "--file", path, "--path", "/tmp/ok.txt"])).toBe(0);
    expect(await policyCommand(["check", "--file", path, "--path", "/tmp/interdit/x"])).toBe(2);
  });

  it("check signale un fichier cassé sans appliquer de défauts", async () => {
    await writeFile(path, "version: 1\nfilesystem:\n  allow: [a, b\n");
    expect(await policyCommand(["check", "--file", path])).toBe(1);
  });

  it("show fonctionne même sans fichier, et dit que tout est refusé", async () => {
    expect(await policyCommand(["show", "--file", join(directory, "absent.yaml")])).toBe(0);
  });

  it("refuse une sous-commande inconnue", async () => {
    expect(await policyCommand(["efface", "--file", path])).toBe(1);
  });
});

describe("l'exemple versionné", () => {
  it("est identique à celui que `init` écrit", async () => {
    // Un exemple versionné se lit sans rien lancer, et c'est son intérêt. Mais
    // une copie dérive : ce test est ce qui l'empêche de mentir.
    const { fileURLToPath } = await import("node:url");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const versioned = await readFile(
      join(here, "..", "..", "..", "services", "windows-worker", "device-policy.example.yaml"),
      "utf8",
    );
    expect(versioned).toBe(POLICY_EXAMPLE);
  });
});

describe("emplacement par défaut", () => {
  it("vit dans ~/.nexus", () => {
    expect(defaultPolicyPath("/home/adlane")).toBe("/home/adlane/.nexus/device-policy.yaml");
  });
});
