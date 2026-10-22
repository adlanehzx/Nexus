import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Boundary between client UI and execution runtime, verified at the source.
 *
 * Ensures the desktop client never directly invokes the worker runtime,
 * never imports OS process/filesystem modules, and strictly preserves
 * the architectural path: UI -> core -> authorization -> worker.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const filePath = join(directory, entry);
    if (statSync(filePath).isDirectory()) {
      found.push(...sourceFiles(filePath));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(filePath);
    }
  }

  return found;
}

/**
 * Strips comments and strings to prevent prose from triggering lint assertions.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const sources = sourceFiles(join(root, "src")).map((filePath) => ({
  filePath: filePath.slice(root.length).replace(/\\/g, "/"),
  code: codeOnly(readFileSync(filePath, "utf8")),
  raw: readFileSync(filePath, "utf8"),
}));

describe("UI isolation from worker runtime", () => {
  it("imports no worker modules", () => {
    const forbidden = [
      "@nexus/worker-core",
      "@nexus/windows-worker",
      "@nexus/android-worker",
      "@nexus/devices",
      "@nexus/agent-core",
      "@nexus/tools",
    ];

    const offenders = sources.filter((file) =>
      forbidden.some((moduleName) => file.code.includes(moduleName)),
    );

    expect(offenders.map((file) => file.filePath)).toEqual([]);
  });

  it("imports no system-level Node modules", () => {
    const forbidden = [
      "node:child_process",
      "node:fs",
      "node:os",
      "node:process",
      "node:net",
      "child_process",
      "execa",
    ];

    const offenders = sources.filter((file) =>
      forbidden.some((moduleName) => new RegExp(`["']${moduleName}["']`).test(file.raw)),
    );

    expect(offenders.map((file) => file.filePath)).toEqual([]);
  });

  it("declares none of the forbidden dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    for (const forbidden of [
      "@nexus/worker-core",
      "@nexus/windows-worker",
      "@nexus/devices",
      "ws",
    ]) {
      expect(declared).not.toContain(forbidden);
    }
  });
});

describe("shell surface area", () => {
  const port = readFileSync(join(root, "src/lib/shell.ts"), "utf8");
  const shells = readFileSync(join(root, "src/lib/shells.ts"), "utf8");

  it("exposes no execution or process spawning capabilities", () => {
    const code = codeOnly(port);

    for (const verb of [
      "exec",
      "spawn",
      "runCommand",
      "shell(",
      "writeFile",
      "readFile",
      "deleteFile",
      "startProcess",
      "killProcess",
    ]) {
      expect(code).not.toContain(verb);
    }
  });

  it("only exposes enumerated native commands", () => {
    const union = /type TauriCommand =([^;]+);/.exec(shells);
    expect(union).not.toBeNull();

    const declared = [...(union?.[1] ?? "").matchAll(/"([a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);

    const rust = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8");
    const block = /invoke_handler\(tauri::generate_handler!\[([^\]]+)\]\)/.exec(rust);
    expect(block).not.toBeNull();

    const exposed = (block?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    expect([...exposed].sort()).toEqual(
      [
        "local_worker_device_id",
        "machine_name",
        "notify",
        "open_external",
        "secret_get",
        "secret_remove",
        "secret_set",
      ].sort(),
    );

    for (const command of exposed) {
      expect(declared).toContain(command);
    }
  });

  it("native shell does not execute processes", () => {
    const rust = readFileSync(join(root, "src-tauri/src/main.rs"), "utf8")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    for (const forbidden of ["Command::new", "std::process::Command", "shell_execute"]) {
      expect(rust).not.toContain(forbidden);
    }
  });
});
