import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathPolicy } from "../src/policy/path-policy.js";
import { NodeFileSystem } from "../src/runtime/file-system.js";

/** Real files and real symlinks: a fake could not show what the disk resolves to. */
describe.skipIf(process.platform === "win32")("path policy on POSIX", () => {
  const fileSystem = new NodeFileSystem();
  let base: string;
  let root: string;
  let policy: PathPolicy;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nexus-path-policy-")));
    root = path.join(base, "workspace");
    await fs.mkdir(root);
    await fs.mkdir(path.join(base, "outside"));
    await fs.writeFile(path.join(root, "hello.txt"), "hello");
    await fs.writeFile(path.join(base, "outside", "secret.txt"), "secret");
    await fs.symlink(path.join(base, "outside"), path.join(root, "escape-dir"));
    await fs.symlink(path.join(base, "outside", "secret.txt"), path.join(root, "escape-file"));
    await fs.symlink(path.join(root, "hello.txt"), path.join(root, "inside-link"));
    policy = new PathPolicy({
      allowedRoots: [root],
      platform: "posix",
      realpath: (candidate) => fileSystem.realpath(candidate),
    });
  });

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("keeps a POSIX path as it is and reads the file", async () => {
    const target = path.join(root, "hello.txt");
    await expect(policy.resolve(target)).resolves.toBe(target);
    await expect(fileSystem.readFile(target, 100)).resolves.toBe("hello");
  });

  it("writes a new file through a directory that does not exist yet", async () => {
    const target = path.join(root, "new", "deep", "file.txt");
    await expect(policy.resolve(target)).resolves.toBe(target);
    await fileSystem.writeFile(target, "written", false);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("written");
  });

  it("accepts the root, and a symlink that stays inside it", async () => {
    await expect(policy.resolve(root)).resolves.toBe(root);
    await expect(policy.resolve(path.join(root, "inside-link"))).resolves.toBe(
      path.join(root, "hello.txt"),
    );
  });

  it("refuses traversal out of the root", async () => {
    await expect(policy.resolve(`${root}/../outside/secret.txt`)).rejects.toThrow();
    await expect(policy.resolve(`${root}/../../../../etc/hosts`)).rejects.toThrow();
  });

  it("allows traversal that ends inside the root", async () => {
    await expect(policy.resolve(`${root}/new/../hello.txt`)).resolves.toBe(
      path.join(root, "hello.txt"),
    );
  });

  it("refuses symlinks leaving the root, including for a file not created yet", async () => {
    await expect(policy.resolve(path.join(root, "escape-file"))).rejects.toThrow();
    await expect(policy.resolve(path.join(root, "escape-dir", "secret.txt"))).rejects.toThrow();
    await expect(policy.resolve(path.join(root, "escape-dir", "new.txt"))).rejects.toThrow();
  });

  it("refuses a sibling sharing the root's prefix", async () => {
    await expect(policy.resolve(`${root}-other/file.txt`)).rejects.toThrow();
  });

  it("treats case as significant for the root", async () => {
    await expect(policy.resolve(root.toUpperCase())).rejects.toThrow();
  });

  it("refuses relative, Windows and empty paths", async () => {
    await expect(policy.resolve("hello.txt")).rejects.toThrow();
    await expect(policy.resolve("C:\\Windows\\win.ini")).rejects.toThrow();
    await expect(policy.resolve("")).rejects.toThrow();
    await expect(policy.resolve(`${root}/a\0b`)).rejects.toThrow();
  });

  it("does not read a backslash as a separator", async () => {
    const literal = await policy.resolve(`${root}/..\\..\\etc`);
    expect(path.dirname(literal)).toBe(root);
  });

  it("still refuses secret locations and system paths", async () => {
    await expect(policy.resolve(path.join(root, ".ssh", "id_ed25519"))).rejects.toThrow();
    const everywhere = new PathPolicy({ allowedRoots: ["/"], platform: "posix" });
    await expect(everywhere.resolve("/etc/shadow")).rejects.toThrow();
    await expect(everywhere.resolve("/proc/self/environ")).rejects.toThrow();
    await expect(everywhere.resolve("/tmp/fine.txt")).resolves.toBe("/tmp/fine.txt");
  });

  it("allows names that only Windows reserves", async () => {
    await expect(policy.resolve(path.join(root, "NUL"))).resolves.toBe(path.join(root, "NUL"));
    await expect(policy.resolve(path.join(root, "a:b"))).resolves.toBe(path.join(root, "a:b"));
  });
});

describe("path policy keeps its Windows protections", () => {
  const policy = new PathPolicy({ allowedRoots: ["C:\\Projets"], platform: "win32" });

  it("normalizes forward slashes and ignores case", async () => {
    await expect(policy.resolve("c:/projets/app.ts")).resolves.toBe("c:\\projets\\app.ts");
  });

  it("refuses streams, reserved names, UNC and traversal", async () => {
    await expect(policy.resolve("C:\\Projets\\a.txt:hidden")).rejects.toThrow();
    await expect(policy.resolve("C:\\Projets\\NUL")).rejects.toThrow();
    await expect(policy.resolve("\\\\server\\share\\file")).rejects.toThrow();
    await expect(policy.resolve("C:\\Projets\\..\\Windows\\win.ini")).rejects.toThrow();
  });

  it("protects Windows system locations", async () => {
    const everywhere = new PathPolicy({ allowedRoots: ["C:\\"], platform: "win32" });
    await expect(everywhere.resolve("C:\\Windows\\System32\\config\\SAM")).rejects.toThrow();
  });
});
