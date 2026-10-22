import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalCapabilityRegistry } from "@nexus/worker-core";
import { parseApplications } from "../src/capabilities/app.js";
import { assembleForTest, ALLOWED_ROOT, type AssembledFixture } from "./fixtures.js";
import type { CapabilityContext } from "@nexus/worker-core";

/**
 * Worker capabilities tested one by one.
 */

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    taskId: "t1",
    stepId: "s1",
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onProgress: () => undefined,
    ...overrides,
  };
}

async function run(fixture: AssembledFixture, name: string, input: unknown, ctx = context()) {
  const capability = fixture.capabilities.require(name);
  const validated = fixture.capabilities.validateInput(name, input);
  return capability.execute(validated as never, ctx);
}

describe("local capability registry", () => {
  it("announces available capabilities", async () => {
    const fixture = await assembleForTest();
    const declared = fixture.capabilities.declare().map((capability) => capability.name);

    expect(declared).toEqual(
      expect.arrayContaining([
        "terminal.execute",
        "filesystem.read",
        "filesystem.write",
        "process.list",
        "process.start",
        "process.stop",
        "docker.execute",
        "git.status",
        "git.pull",
        "git.checkout",
        "git.branch",
        "git.clone",
        "git.commit",
        "git.diff",
        "browser.open",
        "app.open",
      ]),
    );
    expect(declared).toHaveLength(16);
  });

  it("does not announce capability whose tool is missing", async () => {
    const fixture = await assembleForTest({}, ({ runner }) => {
      runner.missing.add("docker");
    });

    const declared = fixture.capabilities.declare().map((capability) => capability.name);
    expect(declared).not.toContain("docker.execute");
    expect(declared).toContain("git.status");
  });

  it("refuses to execute an unavailable capability", async () => {
    const fixture = await assembleForTest({}, ({ runner }) => {
      runner.missing.add("docker");
    });

    expect(() => fixture.capabilities.require("docker.execute")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("only announces capabilities allowed by configuration", async () => {
    const fixture = await assembleForTest({
      declaredCapabilities: ["filesystem.read", "git.status"],
    });

    expect(fixture.capabilities.declare().map((c) => c.name)).toEqual([
      "filesystem.read",
      "git.status",
    ]);
  });

  it("rejects locally unauthorized capability even if present", async () => {
    const fixture = await assembleForTest({ declaredCapabilities: ["filesystem.read"] });

    expect(() => fixture.capabilities.require("terminal.execute")).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
        context: expect.objectContaining({ reason: expect.stringContaining("configuration") }),
      }),
    );
  });

  it("rejects unknown capability", async () => {
    const fixture = await assembleForTest();
    expect(() => fixture.capabilities.require("registry.wipe")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("rejects duplicate capability registration", () => {
    const registry = new LocalCapabilityRegistry();
    const definition = {
      name: "test.echo",
      description: "",
      inputSchema: z.object({}),
      riskLevel: "SAFE" as const,
      execute: () => Promise.resolve({}),
    };

    registry.register(definition);
    expect(() => registry.register(definition)).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("names the faulty field when arguments are invalid", async () => {
    const fixture = await assembleForTest();

    expect(() => fixture.capabilities.validateInput("filesystem.read", { invalidKey: "x" })).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_INPUT_INVALID",
        context: expect.objectContaining({
          issues: expect.arrayContaining([expect.stringContaining("path")]),
        }),
      }),
    );
  });

  it("produces a reasoned capability inventory", async () => {
    const fixture = await assembleForTest(
      { declaredCapabilities: ["filesystem.read", "docker.execute"] },
      ({ runner }) => {
        runner.missing.add("docker");
      },
    );

    const inventory = fixture.capabilities.inventory();
    const docker = inventory.find((entry) => entry.capability.name === "docker.execute");
    const terminal = inventory.find((entry) => entry.capability.name === "terminal.execute");

    expect(docker?.available).toBe(false);
    expect(docker?.reason).toMatch(/missing/i);
    expect(terminal?.reason).toMatch(/configuration/);
  });
});

describe("terminal.execute", () => {
  it("executes an allowed program without shell", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "terminal.execute", {
      executable: "git",
      args: ["status", "--porcelain"],
    })) as { exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(fixture.runner.runs[0]).toMatchObject({
      executable: "git",
      args: ["status", "--porcelain"],
    });
  });

  it("rejects an unauthorized executable", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "terminal.execute", { executable: "curl", args: ["https://example.com"] }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_NOT_ALLOWED" });

    expect(fixture.runner.runs).toHaveLength(0);
  });

  it("rejects mistyped argument according to schema", async () => {
    const fixture = await assembleForTest();
    expect(() =>
      fixture.capabilities.validateInput("terminal.execute", { executable: "git", args: [42] }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("rejects working directory outside allowed roots", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "terminal.execute", {
        executable: "git",
        args: ["status"],
        workingDirectory: "C:\\Windows\\System32",
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });

    expect(fixture.runner.runs).toHaveLength(0);
  });

  it("translates execution timeout into retryable error", async () => {
    const fixture = await assembleForTest();
    fixture.runner.outcomes.set("git", { status: "timeout", exitCode: null });

    await expect(
      run(fixture, "terminal.execute", { executable: "git", args: ["log"] }),
    ).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT", retryable: true });
  });

  it("propagates cancellation to underlying process", async () => {
    const fixture = await assembleForTest();
    fixture.runner.hangUntilAborted = true;

    const controller = new AbortController();
    const pending = run(
      fixture,
      "terminal.execute",
      { executable: "git", args: ["log"] },
      context({ signal: controller.signal }),
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
  });

  it("only transmits allowed environment variables", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "terminal.execute", { executable: "git", args: ["status"] });

    expect(fixture.runner.runs[0]?.env).toEqual({
      PATH: "C:\\Windows;C:\\Program Files\\Git\\cmd",
      TEMP: "C:\\Temp",
    });
  });

  it("redacts secrets from process output", async () => {
    const fixture = await assembleForTest();
    fixture.runner.outcomes.set("git", {
      stdout: "remote: https://x-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b\n",
      stderr: "API_KEY=sk-abcdefghijklmnopqrstuvwx",
    });

    const result = (await run(fixture, "terminal.execute", {
      executable: "git",
      args: ["push"],
    })) as { stdout: string; stderr: string };

    expect(result.stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(result.stderr).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(result.stdout).toContain("[REDACTED]");
  });
});

describe("filesystem", () => {
  it("reads an allowed file", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(`${ALLOWED_ROOT}\\notes.md`, "hello");
    });

    const result = (await run(fixture, "filesystem.read", {
      path: `${ALLOWED_ROOT}\\notes.md`,
    })) as { content: string };

    expect(result.content).toBe("hello");
  });

  it("rejects read outside allowed roots", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "filesystem.read", { path: "C:\\Users\\me\\.aws\\credentials" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("rejects traversal via ..", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "filesystem.read", { path: `${ALLOWED_ROOT}\\..\\Windows\\win.ini` }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("redacts secrets in read files", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(
        `${ALLOWED_ROOT}\\.env`,
        "DB_HOST=localhost\nAPI_KEY=sk-secret1234567890abcd\n",
      );
    });

    const result = (await run(fixture, "filesystem.read", {
      path: `${ALLOWED_ROOT}\\.env`,
    })) as { content: string };

    expect(result.content).toContain("DB_HOST=localhost");
    expect(result.content).not.toContain("sk-secret1234567890abcd");
  });

  it("writes an allowed file", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "filesystem.write", {
      path: `${ALLOWED_ROOT}\\out.txt`,
      content: "ok",
    })) as { created: boolean; bytesWritten: number };

    expect(result).toMatchObject({ created: true, bytesWritten: 2 });
    expect(fixture.fileSystem.files.get(`${ALLOWED_ROOT}\\out.txt`)).toBe("ok");
  });

  it("rejects write outside allowed roots", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "filesystem.write", { path: "C:\\Windows\\evil.dll", content: "x" }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });

    expect(fixture.fileSystem.writes).toHaveLength(0);
  });

  it("refuses to overwrite existing file without explicit flag", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(`${ALLOWED_ROOT}\\important.txt`, "six months of work");
    });

    await expect(
      run(fixture, "filesystem.write", {
        path: `${ALLOWED_ROOT}\\important.txt`,
        content: "oops",
      }),
    ).rejects.toMatchObject({ code: "WORKER_POLICY_VIOLATION" });

    expect(fixture.fileSystem.files.get(`${ALLOWED_ROOT}\\important.txt`)).toBe(
      "six months of work",
    );
  });

  it("allows overwrite when explicitly requested", async () => {
    const fixture = await assembleForTest({}, ({ fileSystem }) => {
      fileSystem.files.set(`${ALLOWED_ROOT}\\draft.txt`, "old");
    });

    await run(fixture, "filesystem.write", {
      path: `${ALLOWED_ROOT}\\draft.txt`,
      content: "new",
      overwrite: true,
    });

    expect(fixture.fileSystem.files.get(`${ALLOWED_ROOT}\\draft.txt`)).toBe("new");
  });
});

describe("process", () => {
  it("lists running processes", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "process.list", {})) as { total: number };
    expect(result.total).toBe(2);
  });

  it("filters process list by name", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "process.list", { nameContains: "chrome" })) as {
      total: number;
    };
    expect(result.total).toBe(1);
  });

  it("starts an allowed program", async () => {
    const fixture = await assembleForTest();
    const started = (await run(fixture, "process.start", {
      executable: "node",
      args: ["server.js"],
    })) as { processId: number };

    expect(started.processId).toBeGreaterThan(0);
    expect(fixture.runner.started[0]).toMatchObject({ executable: "node" });
  });

  it("refuses to start an unauthorized program", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "process.start", { executable: "regedit", args: [] }),
    ).rejects.toMatchObject({ code: "EXECUTABLE_NOT_ALLOWED" });
  });

  it("stops a process launched by NEXUS", async () => {
    const fixture = await assembleForTest();
    const started = (await run(fixture, "process.start", {
      executable: "node",
      args: [],
    })) as { processId: number };

    const stopped = (await run(fixture, "process.stop", {
      processId: started.processId,
    })) as { stopped: boolean };

    expect(stopped.stopped).toBe(true);
  });

  it("refuses to stop a process not launched by NEXUS", async () => {
    const fixture = await assembleForTest();
    await expect(run(fixture, "process.stop", { processId: 1001 })).rejects.toMatchObject({
      code: "WORKER_POLICY_VIOLATION",
      context: expect.objectContaining({ rule: "process.notOwned" }),
    });

    expect(fixture.runner.stopped).toHaveLength(0);
  });
});

describe("docker", () => {
  it("executes an allowed inspection operation", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "docker.execute", { subcommand: "ps", args: ["-a"] });

    const dockerRuns = fixture.runner.runs.filter((r) => r.executable === "docker");
    expect(dockerRuns.at(-1)?.args).toEqual(["ps", "-a"]);
  });

  it("rejects unauthorized operation", async () => {
    const fixture = await assembleForTest();
    await expect(
      run(fixture, "docker.execute", { subcommand: "run", args: ["ubuntu"] }),
    ).rejects.toMatchObject({ code: "WORKER_POLICY_VIOLATION" });
  });

  it("redacts secrets from container logs", async () => {
    const fixture = await assembleForTest();
    fixture.runner.outcomes.set("docker", {
      stdout: "env: DATABASE_PASSWORD=secretpassword\n",
    });

    const result = (await run(fixture, "docker.execute", {
      subcommand: "logs",
      args: ["api"],
    })) as { stdout: string };

    expect(result.stdout).not.toContain("secretpassword");
  });
});

describe("git", () => {
  it("executes read operation without write permission", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "git.status", { repositoryPath: `${ALLOWED_ROOT}\\leynai` });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.args).toEqual(["status", "--porcelain=v1", "--branch"]);
    expect(gitRuns.at(-1)?.cwd).toBe(`${ALLOWED_ROOT}\\leynai`);
  });

  it("rejects mutating operation in read-only mode", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: false });
    await expect(
      run(fixture, "git.pull", { repositoryPath: `${ALLOWED_ROOT}\\leynai` }),
    ).rejects.toMatchObject({
      code: "WORKER_POLICY_VIOLATION",
      context: expect.objectContaining({ rule: "git.readOnly" }),
    });
  });

  it("authorizes mutating operations when configured", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await run(fixture, "git.pull", { repositoryPath: `${ALLOWED_ROOT}\\leynai` });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.args).toEqual(["pull", "--ff-only", "origin"]);
  });

  it("prevents Git from hanging on password prompts", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await run(fixture, "git.pull", { repositoryPath: `${ALLOWED_ROOT}\\leynai` });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" });
  });

  it("rejects branch name that looks like a CLI flag", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    expect(() =>
      fixture.capabilities.validateInput("git.checkout", {
        repositoryPath: `${ALLOWED_ROOT}\\leynai`,
        branch: "--orphan",
      }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("closes option list after branch name", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await run(fixture, "git.checkout", {
      repositoryPath: `${ALLOWED_ROOT}\\leynai`,
      branch: "main",
    });

    const gitRuns = fixture.runner.runs.filter((r) => r.executable === "git");
    expect(gitRuns.at(-1)?.args).toEqual(["checkout", "main", "--"]);
  });

  it("rejects clone from unauthorized host", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await expect(
      run(fixture, "git.clone", {
        url: "https://evil.example/x.git",
        destination: `${ALLOWED_ROOT}\\x`,
      }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "git.remoteHost" }) });
  });

  it("rejects clone to destination outside allowed roots", async () => {
    const fixture = await assembleForTest({ gitAllowWrite: true });
    await expect(
      run(fixture, "git.clone", {
        url: "https://github.com/example/project.git",
        destination: "C:\\Windows\\Temp\\x",
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});

describe("browser.open", () => {
  it("opens https URL", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "browser.open", {
      url: "https://example.com/page",
    })) as { opened: boolean };

    expect(result.opened).toBe(true);
  });

  it("rejects schemes other than http(s)", async () => {
    const fixture = await assembleForTest();
    expect(() =>
      fixture.capabilities.validateInput("browser.open", { url: "file:///C:/Windows/win.ini" }),
    ).not.toThrow();

    await expect(
      run(fixture, "browser.open", { url: "file:///C:/Windows/win.ini" }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "browser.protocol" }) });
  });
});

describe("app.open", () => {
  it("opens known application without awaiting window close", async () => {
    const fixture = await assembleForTest();
    const result = (await run(fixture, "app.open", { app: "chrome" })) as { app: string };

    expect(result.app).toBe("chrome");
    expect(fixture.runner.started).toHaveLength(1);
    expect(fixture.runner.started[0]?.executable).toContain("chrome.exe");
    expect(fixture.runner.started[0]?.args).toEqual([]);
    expect(fixture.runner.runs).toHaveLength(0);
  });

  it("application name is case insensitive", async () => {
    const fixture = await assembleForTest();
    await expect(run(fixture, "app.open", { app: "Chrome" })).resolves.toBeDefined();
  });

  it("rejects unknown application and lists known ones", async () => {
    const fixture = await assembleForTest();

    await expect(run(fixture, "app.open", { app: "malicious" })).rejects.toMatchObject({
      code: "EXECUTABLE_NOT_ALLOWED",
    });
    expect(fixture.runner.started).toHaveLength(0);
  });

  it("does not accept paths", async () => {
    const fixture = await assembleForTest();

    for (const app of [
      "C:\\Windows\\System32\\cmd.exe",
      "..\\..\\payload.exe",
      "chrome.exe",
      "/usr/bin/env",
    ]) {
      await expect(run(fixture, "app.open", { app }), app).rejects.toMatchObject({
        code: "EXECUTABLE_NOT_ALLOWED",
      });
    }

    expect(fixture.runner.started).toHaveLength(0);
  });

  it("does not forward worker environment to opened application", async () => {
    const fixture = await assembleForTest();
    await run(fixture, "app.open", { app: "notepad" });

    const transmitted = Object.keys(fixture.runner.started[0]?.env ?? {});
    expect(transmitted).toEqual(expect.arrayContaining([]));
    expect(transmitted).not.toContain("DEVICE_CREDENTIAL_PATH");
  });
});

describe("applications table", () => {
  it("parses well-formed entries", () => {
    const parsed = parseApplications([
      "chrome=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "Spotify=C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe",
    ]);

    expect(parsed.get("chrome")).toContain("chrome.exe");
    expect(parsed.get("spotify")).toContain("Spotify.exe");
  });

  it("ignores malformed entries gracefully without failing startup", () => {
    const parsed = parseApplications([
      "no-separator",
      "=no-name",
      "no-path=",
      "null=C:\\a\u0000b.exe",
      "valid=C:\\Windows\\notepad.exe",
    ]);

    expect([...parsed.keys()]).toEqual(["valid"]);
  });
});
