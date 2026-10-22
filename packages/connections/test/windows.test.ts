import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeProcessPort, UnsupportedExecutableError, launchability } from "../src/node-process.js";
import { SafeCommandRunner } from "../src/probes.js";
import { BUILT_IN_PROVIDERS } from "../src/providers.js";
import { FakeClock } from "./fake-binaries.js";

/**
 * Windows npm shim semantics.
 *
 * ## What these tests can and cannot establish
 *
 * They establish the policy: what NEXUS does when it resolves a `.cmd`, and
 * that it never reaches for a shell. The platform is injected, so every branch
 * runs on this repository's Linux CI.
 *
 * They do **not** establish Node's actual behaviour on Windows. That was taken
 * from Node's documented restriction on spawning `.bat` and `.cmd` without a
 * shell, introduced with the fix for CVE-2024-27980, and has not been observed
 * on a Windows machine from here. The conclusion drawn — refuse rather than
 * work around — is safe whichever way that behaviour goes, since the refusal is
 * ours and does not depend on Node refusing too.
 */

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

describe("launch policy", () => {
  it.each([".cmd", ".CMD", ".bat", ".BAT"])("refuses %s on Windows", (extension) => {
    const verdict = launchability(`C:\\tools\\codex${extension}`, "win32");

    expect(verdict.launchable).toBe(false);
  });

  it.each([".exe", ".com", ""])("allows %s on Windows", (extension) => {
    expect(launchability(`C:\\tools\\codex${extension}`, "win32").launchable).toBe(true);
  });

  it("gives a reason a reader can act on", () => {
    const verdict = launchability("C:\\tools\\codex.cmd", "win32");

    expect(verdict.launchable === false && verdict.reason).toMatch(/command interpreter/);
  });

  it.each(["linux", "darwin"] as const)(
    "attaches no meaning to the extension on %s",
    (platform) => {
      // A file called `thing.cmd` on Linux is just a file called `thing.cmd`.
      expect(launchability("/usr/local/bin/thing.cmd", platform).launchable).toBe(true);
    },
  );
});

describe("refusing to launch a Windows shim", () => {
  it("throws a type the caller can distinguish from a missing file", () => {
    const port = new NodeProcessPort({ path: "", platform: "win32" });

    expect(() => port.spawn("C:\\tools\\codex.cmd", ["--version"], { env: {} })).toThrow(
      UnsupportedExecutableError,
    );
  });

  it("reports unsupported_platform rather than not_found", async () => {
    // The distinction matters to whoever reads it: the tool IS installed, and
    // "not installed" would send them to reinstall something that is fine.
    const runner = new SafeCommandRunner({
      process: {
        which: () => Promise.resolve("C:\\tools\\codex.cmd"),
        spawn: new NodeProcessPort({ path: "", platform: "win32" }).spawn.bind(
          new NodeProcessPort({ path: "", platform: "win32" }),
        ),
      },
      clock: new FakeClock(),
    });

    const outcome = await runner.run({ file: "codex", args: ["--version"] });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorCategory).toBe("unsupported_platform");
  });

  it("never starts a process for a shim", async () => {
    let spawned = 0;
    const port = new NodeProcessPort({ path: "", platform: "win32" });
    const runner = new SafeCommandRunner({
      process: {
        which: () => Promise.resolve("C:\\tools\\codex.cmd"),
        spawn: (file, args, options) => {
          spawned += 1;
          return port.spawn(file, args, options);
        },
      },
      clock: new FakeClock(),
    });

    await runner.run({ file: "codex", args: ["--version"] });

    // The refusal happens inside spawn, so the counter sees the attempt — what
    // must not happen is a child process, which the throw prevents.
    expect(spawned).toBe(1);
  });
});

/**
 * Strips comments so a source-level assertion reads code rather than prose.
 *
 * Needed because the modules explain at length why they never use a shell, and
 * an assertion that cannot tell an explanation from an instruction would fail on
 * its own documentation — or, worse, be weakened until it passed.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("no shell, anywhere", () => {
  it("never passes shell: true", async () => {
    // A source-level assertion, because this is the one option whose
    // reintroduction would silently undo the whole package. A reviewer can miss
    // a single word in a diff; this cannot.
    for (const file of ["node-process.ts", "probes.ts", "detect.ts", "providers.ts"]) {
      const source = codeOnly(await readFile(join(SOURCE_DIR, file), "utf8"));
      expect(source).not.toMatch(/shell:\s*true/);
    }
  });

  it("can tell code from the comments that discuss it", () => {
    // Guards the stripper itself: without this, a stripper that removed
    // everything would make the assertion above vacuous.
    expect(codeOnly("const a = 1; // shell: true")).not.toMatch(/shell:\s*true/);
    expect(codeOnly("spawn(f, a, { shell: true });")).toMatch(/shell:\s*true/);
    expect(codeOnly("/* shell: true */ const b = 2;")).not.toMatch(/shell:\s*true/);
  });

  it("states shell: false explicitly where a process is started", async () => {
    const source = codeOnly(await readFile(join(SOURCE_DIR, "node-process.ts"), "utf8"));

    // Explicit rather than relying on the default, so that a reader of this one
    // line does not have to know what the default is.
    expect(source).toMatch(/shell:\s*false/);
  });
});

describe("declared platform support", () => {
  it("does not claim Windows", () => {
    // Claiming it would mean either lying about what works or adding a shell.
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(provider.platforms).not.toContain("win32");
    }
  });

  it("claims the platforms that were actually exercised", () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect([...provider.platforms].toSorted()).toEqual(["darwin", "linux"]);
    }
  });
});
