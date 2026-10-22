import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConnectionDetector } from "../src/detect.js";
import { NodePackageResolver, isPlainPackageName } from "../src/node-packages.js";
import { NodeProcessPort, SystemClock } from "../src/node-process.js";
import { SafeCommandRunner } from "../src/probes.js";
import { ProviderRegistry, type ProviderDefinition } from "../src/registry.js";
import { createFakeBinDir } from "./fake-binaries.js";

/**
 * Adapter presence is a question about the ACP adapter, asked on the
 * filesystem, and answered without starting anything.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

/** Creates a tree with `node_modules/<name>/package.json` under `from`. */
async function treeWithPackage(
  name: string,
  options: { depth?: number; emptyDirOnly?: boolean } = {},
): Promise<{ from: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "nexus-adapter-"));
  const from = join(
    root,
    ...Array.from({ length: options.depth ?? 0 }, (_, i) => `level${String(i)}`),
  );
  await mkdir(from, { recursive: true });
  const installed = join(root, "node_modules", name);
  await mkdir(installed, { recursive: true });
  if (options.emptyDirOnly !== true) {
    await writeFile(join(installed, "package.json"), JSON.stringify({ name }), "utf8");
  }
  return { from, root };
}

posixOnly("package resolution", () => {
  it("finds a package installed beside the starting directory", async () => {
    const { from } = await treeWithPackage("some-adapter");
    const resolver = new NodePackageResolver({ from });

    await expect(resolver.resolve("some-adapter")).resolves.toContain("some-adapter");
  });

  it("walks upwards like Node does", async () => {
    const { from } = await treeWithPackage("some-adapter", { depth: 4 });
    const resolver = new NodePackageResolver({ from });

    await expect(resolver.resolve("some-adapter")).resolves.toBeDefined();
  });

  it("handles a scoped name", async () => {
    const { from } = await treeWithPackage("@agentclientprotocol/codex-acp");
    const resolver = new NodePackageResolver({ from });

    await expect(resolver.resolve("@agentclientprotocol/codex-acp")).resolves.toBeDefined();
  });

  it("reports an absent package as absent rather than throwing", async () => {
    const { from } = await treeWithPackage("some-adapter");
    const resolver = new NodePackageResolver({ from });

    // Absence is an answer, and a throw here would force every caller to wrap
    // a question that has a perfectly good negative result.
    await expect(resolver.resolve("never-installed")).resolves.toBeUndefined();
  });

  it("does not count an empty leftover directory as installed", async () => {
    const { from } = await treeWithPackage("some-adapter", { emptyDirOnly: true });
    const resolver = new NodePackageResolver({ from });

    // pnpm leaves these behind; a directory without a package.json is not a
    // package, and treating it as one would report a removed adapter as present.
    await expect(resolver.resolve("some-adapter")).resolves.toBeUndefined();
  });

  it("consults extra roots for installs that do not sit above the cwd", async () => {
    const { root } = await treeWithPackage("global-adapter");
    const elsewhere = await mkdtemp(join(tmpdir(), "nexus-elsewhere-"));
    const resolver = new NodePackageResolver({
      from: elsewhere,
      extraRoots: [join(root, "node_modules")],
    });

    await expect(resolver.resolve("global-adapter")).resolves.toBeDefined();
  });

  it.each(["../escape", "/abs/path", "sub/dir/deep", "..", "", "UPPER", "a\\\\b"])(
    "refuses %j as a package name",
    async (name) => {
      // A name reaches this from a provider definition, which is code; the
      // validation removes the question rather than relying on that.
      expect(isPlainPackageName(name)).toBe(false);
      const { from } = await treeWithPackage("some-adapter");
      await expect(new NodePackageResolver({ from }).resolve(name)).resolves.toBeUndefined();
    },
  );

  it("refuses a name that would escape node_modules", async () => {
    // Without validation this is observable rather than theoretical: the
    // traversal lands on a real package.json one level above node_modules, so
    // a name chosen elsewhere could make an unrelated directory read as an
    // installed adapter.
    const { root, from } = await treeWithPackage("some-adapter");
    const escaped = join(root, "escape-target");
    await mkdir(escaped, { recursive: true });
    await writeFile(join(escaped, "package.json"), '{"name":"escape-target"}', "utf8");

    await expect(
      new NodePackageResolver({ from: root }).resolve("../escape-target"),
    ).resolves.toBeUndefined();
    void from;
  });

  it.each(["codex-acp", "@scope/name", "a", "with.dots", "with_underscore"])(
    "accepts %j",
    (name) => {
      expect(isPlainPackageName(name)).toBe(true);
    },
  );
});

posixOnly("adapter availability from a package probe", () => {
  function provider(probe: ProviderDefinition["adapter"]["probe"]): ProviderDefinition {
    return {
      id: "fixture",
      displayName: "Fixture Tool",
      kind: "acp",
      platforms: ["linux", "darwin"],
      adapter: {
        provenance: "community",
        provenanceEvidence: "test fixture, not a real adapter",
        ...(probe === undefined ? {} : { probe }),
      },
      detect: {
        command: { file: "fixture", args: ["--version"] },
        verification: "verified",
        interpret: () => ({ version: "1.2.3" }),
      },
      actions: ["detect"],
    };
  }

  async function detect(definition: ProviderDefinition, options: { resolverFrom?: string } = {}) {
    const bin = await createFakeBinDir();
    await bin.write("fixture", 'echo "fixture 1.2.3"');
    const clock = new SystemClock();
    const detector = new ConnectionDetector({
      registry: new ProviderRegistry([definition]),
      runner: new SafeCommandRunner({
        process: new NodeProcessPort({ path: bin.dir, platform: "linux" }),
        clock,
      }),
      clock,
      platform: "linux",
      ...(options.resolverFrom === undefined
        ? {}
        : { packages: new NodePackageResolver({ from: options.resolverFrom }) }),
    });
    return detector.detect("fixture");
  }

  it("reports available when the adapter package is installed", async () => {
    const { from } = await treeWithPackage("fixture-adapter");

    const connection = await detect(
      provider({
        kind: "package",
        packageName: "fixture-adapter",
        verification: "verified",
        absenceProves: "nothing",
      }),
      { resolverFrom: from },
    );

    expect(connection.adapter?.availability).toBe("available");
  });

  it("reports unknown, not missing, when absence proves nothing", async () => {
    const { from } = await treeWithPackage("something-else");

    const connection = await detect(
      provider({
        kind: "package",
        packageName: "fixture-adapter",
        verification: "verified",
        // The `npx -y` case: the adapter is fetched on demand, so no local
        // copy is not evidence it will fail.
        absenceProves: "nothing",
      }),
      { resolverFrom: from },
    );

    expect(connection.adapter?.availability).toBe("unknown");
  });

  it("reports missing only when the provider says absence is evidence", async () => {
    const { from } = await treeWithPackage("something-else");

    const connection = await detect(
      provider({
        kind: "package",
        packageName: "fixture-adapter",
        verification: "verified",
        absenceProves: "missing",
      }),
      { resolverFrom: from },
    );

    expect(connection.adapter?.availability).toBe("missing");
  });

  it("stays unknown when no resolver was supplied", async () => {
    const connection = await detect(
      provider({
        kind: "package",
        packageName: "fixture-adapter",
        verification: "verified",
        absenceProves: "missing",
      }),
    );

    // Nothing looked. Saying `missing` would turn a gap in the caller's wiring
    // into a claim about the user's machine.
    expect(connection.adapter?.availability).toBe("unknown");
  });

  it("caps an unverified package probe at unknown", async () => {
    const { from } = await treeWithPackage("fixture-adapter");

    const connection = await detect(
      provider({
        kind: "package",
        packageName: "fixture-adapter",
        verification: "unverified",
        absenceProves: "nothing",
      }),
      { resolverFrom: from },
    );

    expect(connection.adapter?.availability).toBe("unknown");
  });

  it("answers about the adapter independently of the CLI", async () => {
    const { from } = await treeWithPackage("fixture-adapter");
    const definition = provider({
      kind: "package",
      packageName: "fixture-adapter",
      verification: "verified",
      absenceProves: "nothing",
    });
    // An empty bin directory: the CLI is absent while the adapter is installed.
    const empty = await createFakeBinDir();
    const clock = new SystemClock();
    const detector = new ConnectionDetector({
      registry: new ProviderRegistry([definition]),
      runner: new SafeCommandRunner({
        process: new NodeProcessPort({ path: empty.dir, platform: "linux" }),
        clock,
      }),
      clock,
      platform: "linux",
      packages: new NodePackageResolver({ from }),
    });

    const connection = await detector.detect("fixture");

    // The pairing a boolean could not express: no CLI, adapter present. The
    // detector does not probe the adapter when the CLI is gone, so this stays
    // `unknown` — and that is still not derived from the CLI's absence.
    expect(connection.state).toBe("not_installed");
    expect(connection.adapter?.availability).toBe("unknown");
    expect(connection.authStatus).toBe("unknown");
  });

  it("never puts a filesystem path into the connection", async () => {
    const { from } = await treeWithPackage("fixture-adapter");

    const connection = await detect(
      provider({
        kind: "package",
        packageName: "fixture-adapter",
        verification: "verified",
        absenceProves: "nothing",
      }),
      { resolverFrom: from },
    );

    // The resolver learns where the adapter lives; the Connection carries only
    // the verdict. A temp path in an API response is an information leak that
    // nobody notices until it is in a bug report.
    expect(JSON.stringify(connection)).not.toContain(from);
  });
});
