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

describe("default closed posture", () => {
  it("denies all paths without declared roots", () => {
    const decision = checkPath(CLOSED_POLICY, "/srv/nexus-user/projets/a.txt", HOME);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no allowed roots");
  });

  it("rejects unknown keys instead of ignoring them", () => {
    const parsed = devicePolicySchema.safeParse({ version: 1, filesysteme: { allow: ["/"] } });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown version", () => {
    expect(devicePolicySchema.safeParse({ version: 2 }).success).toBe(false);
  });
});

describe("paths", () => {
  it("allows paths under declared roots", () => {
    expect(checkPath(policy(), "~/projets/nexus/README.md", HOME).allowed).toBe(true);
    expect(checkPath(policy(), "/srv/nexus-user/projets", HOME).allowed).toBe(true);
  });

  it("denies paths outside declared roots", () => {
    expect(checkPath(policy(), "/etc/passwd", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/autre", HOME).allowed).toBe(false);
  });

  it("does not match raw string prefixes across directory boundaries", () => {
    expect(checkPath(policy(), "/srv/nexus-user/projets2/secret", HOME).allowed).toBe(false);
  });

  it("deny rules take precedence even under allowed roots", () => {
    const withSshInside = devicePolicySchema.parse({
      version: 1,
      filesystem: { allow: ["~"], deny: { under: ["~/.ssh"] } },
    });
    expect(checkPath(withSshInside, "~/un-fichier", HOME).allowed).toBe(true);
    const refused = checkPath(withSshInside, "~/.ssh/id_ed25519", HOME);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("~/.ssh");
  });

  it("denies matching segment anywhere in path", () => {
    const refused = checkPath(policy(), "~/projets/app/node_modules/paquet/index.js", HOME);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("node_modules");
    expect(checkPath(policy(), "~/projets/node_modules_doc/notes.md", HOME).allowed).toBe(true);
  });

  it("denies filename matching trailing wildcard", () => {
    expect(checkPath(policy(), "~/projets/.env", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/projets/.env.local", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/projets/environnement.md", HOME).allowed).toBe(true);
  });

  it("denies exact filename without wildcard", () => {
    const exact = devicePolicySchema.parse({
      version: 1,
      filesystem: { allow: ["~"], deny: { names: ["id_rsa"] } },
    });
    expect(checkPath(exact, "~/id_rsa", HOME).allowed).toBe(false);
    expect(checkPath(exact, "~/id_rsa.pub", HOME).allowed).toBe(true);
  });

  it("rejects wildcards positioned other than trailing", () => {
    for (const bad of ["*.env", "a*b", "**"]) {
      const parsed = devicePolicySchema.safeParse({
        version: 1,
        filesystem: { deny: { names: [bad] } },
      });
      expect(parsed.success, bad).toBe(false);
    }
  });

  it("denies paths case-insensitively", () => {
    expect(checkPath(policy(), "~/projets/.ENV", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/projets/NODE_MODULES/x", HOME).allowed).toBe(false);
    expect(checkPath(policy(), "~/.SSH/id_ed25519", HOME).allowed).toBe(false);
  });

  it("expands tilde to home directory", () => {
    expect(expandPath("~/x", HOME)).toBe("/srv/nexus-user/x");
    expect(expandPath("~", HOME)).toBe(HOME);
    expect(expandPath("/absolu", HOME)).toBe("/absolu");
  });

  it("normalizes path traversal attacks", () => {
    expect(checkPath(policy(), "/srv/nexus-user/projets/../.ssh/id_ed25519", HOME).allowed).toBe(
      false,
    );
  });
});

describe("execution", () => {
  it("delegates to worker default list when unspecified", () => {
    expect(checkExecutable(policy(), "git").allowed).toBe(true);
  });

  it("denies executables not in allowlist when specified", () => {
    const restricted = devicePolicySchema.parse({
      version: 1,
      exec: { allowedExecutables: ["git", "node"] },
    });
    expect(checkExecutable(restricted, "git").allowed).toBe(true);
    expect(checkExecutable(restricted, "GIT").allowed).toBe(true);
    expect(checkExecutable(restricted, "curl").allowed).toBe(false);
  });

  it("disabled mode blocks execution unconditionally", () => {
    const disabled = devicePolicySchema.parse({
      version: 1,
      exec: { mode: "disabled", allowedExecutables: ["git"] },
    });
    expect(checkExecutable(disabled, "git").allowed).toBe(false);
  });

  it("rejects unsupported modes like confirm-all", () => {
    expect(
      devicePolicySchema.safeParse({ version: 1, exec: { mode: "confirm-all" } }).success,
    ).toBe(false);
  });
});

describe("file loading", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-policy-"));
    path = join(directory, "device-policy.yaml");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns closed policy when file does not exist", async () => {
    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("défaut");
    expect(loaded.policy).toEqual(CLOSED_POLICY);
  });

  it("loads a valid policy file", async () => {
    await writeFile(
      path,
      [
        "version: 1",
        "filesystem:",
        "  allow:",
        "    - ~/projets",
        "  deny:",
        "    under:",
        "      - ~/.ssh",
      ].join("\n"),
    );
    const loaded = await loadDevicePolicy(path);
    expect(loaded.source).toBe("fichier");
    expect(loaded.policy.filesystem.allow).toEqual(["~/projets"]);
    expect(loaded.policy.filesystem.deny.under).toEqual(["~/.ssh"]);
  });

  it("throws on invalid YAML syntax", async () => {
    await writeFile(path, "version: [unclosed");
    await expect(loadDevicePolicy(path)).rejects.toThrow(DevicePolicyFileError);
  });

  it("throws on schema violations", async () => {
    await writeFile(path, ["version: 1", "filesystem:", "  cle-inconnue: true"].join("\n"));
    await expect(loadDevicePolicy(path)).rejects.toThrow(DevicePolicyFileError);
  });
});

describe("display formatting", () => {
  it("renders entire policy configuration", () => {
    const text = describePolicy({ policy: policy(), source: "fichier", path: "/tmp/p.yaml" });
    for (const expected of [
      "allowed roots",
      "denied under",
      "denied segments",
      "denied names",
      "max file size",
      "mode",
      "executables",
      "environment",
      "git write",
      "docker",
      "egress network",
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toContain("/tmp/p.yaml");
  });

  it("indicates empty lists explicitly", () => {
    const text = describePolicy({ policy: CLOSED_POLICY, source: "défaut", path: undefined });
    expect(text).toContain("none — all denied");
  });
});
