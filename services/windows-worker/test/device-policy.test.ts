import { describe, expect, it } from "vitest";
import { devicePolicySchema } from "@nexus/device-policy";
import { assembleCapabilities } from "../src/assemble.js";
import { PathPolicy } from "../src/policy/path-policy.js";
import { testConfig } from "./fixtures.js";

/**
 * Verifies that local policy is properly applied by the worker.
 */

const policy = (overrides: Record<string, unknown>) =>
  devicePolicySchema.parse({ version: 1, ...overrides });

const advertised = (assembled: ReturnType<typeof assembleCapabilities>): string[] =>
  assembled.capabilities.declare().map((capability) => capability.name);

describe("configurable path denials", () => {
  const base = {
    allowedRoots: ["C:\\Projets"],
    realpath: (candidate: string) => Promise.resolve(candidate),
  };

  it("rejects segment declared by policy", async () => {
    const strict = new PathPolicy({ ...base, deniedSegments: ["clients"] });
    await expect(strict.resolve("C:\\Projets\\clients\\contract.md")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\app\\index.ts")).resolves.toContain("index.ts");
  });

  it("rejects declared name with trailing wildcard", async () => {
    const strict = new PathPolicy({ ...base, deniedNames: [".env*"] });
    await expect(strict.resolve("C:\\Projets\\app\\.env")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\app\\.env.local")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\app\\environment.md")).resolves.toBeTruthy();
  });

  it("ignores case like the filesystem", async () => {
    const strict = new PathPolicy({ ...base, deniedNames: [".env*"], deniedSegments: ["clients"] });
    await expect(strict.resolve("C:\\Projets\\app\\.ENV")).rejects.toThrow();
    await expect(strict.resolve("C:\\Projets\\CLIENTS\\x")).rejects.toThrow();
  });

  it("never opens what worker inherently denies", async () => {
    const permissive = new PathPolicy({ allowedRoots: ["C:\\"], realpath: base.realpath });
    await expect(permissive.resolve("C:\\Users\\me\\.ssh\\id_ed25519")).rejects.toThrow();
    await expect(permissive.resolve("C:\\Windows\\System32\\config\\SAM")).rejects.toThrow();
  });
});

describe("daemon assembly with policy", () => {
  it("without policy, configures from environment", () => {
    const assembled = assembleCapabilities({ config: testConfig() });
    expect(assembled.pathPolicy.roots.length).toBeGreaterThan(0);
    expect(advertised(assembled)).toContain("terminal.execute");
  });

  it("with policy, policy roots take precedence", async () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({ filesystem: { allow: ["C:\\Allowed"] } }),
    });
    expect(assembled.pathPolicy.roots.some((root) => root.includes("Allowed"))).toBe(true);
    await expect(assembled.pathPolicy.resolve("C:\\Allowed\\x.txt")).resolves.toBeTruthy();
  });

  it("policy denials apply under an allowed root", async () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({
        filesystem: { allow: ["C:\\Allowed"], deny: { names: ["secret*"] } },
      }),
    });
    await expect(assembled.pathPolicy.resolve("C:\\Allowed\\secret.txt")).rejects.toThrow();
  });

  it("disabled exec mode does not declare execution capabilities", () => {
    const assembled = assembleCapabilities({
      config: testConfig(),
      devicePolicy: policy({ exec: { mode: "disabled" } }),
    });
    const names = advertised(assembled);
    expect(names).not.toContain("terminal.execute");
    expect(names).not.toContain("process.start");
    expect(names).toContain("filesystem.read");
  });

  it("policy controls git and docker permissions", () => {
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
