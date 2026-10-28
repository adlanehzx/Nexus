import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { makeHarness, until, ALLOWED_ROOT, type WorkerHarness } from "./fixtures.js";
import { loadWorkerConfig } from "../src/config.js";

/**
 * Worker security properties verified as tests.
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-sec",
      stepId: `step-${String(sequence)}`,
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { executable: "git", args: ["status"] },
      timeoutMs: 10_000,
      riskLevel: "HIGH",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: WorkerHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: WorkerHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

describe("no arbitrary execution entrypoint", () => {
  const sourceDirectory = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

  function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
      else if (entry.endsWith(".ts")) files.push(full);
    }
    return files;
  }

  it("never imports shell-based primitives", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(sourceDirectory)) {
      const content = readFileSync(file, "utf8");

      const imports = content.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g);
      for (const match of imports) {
        const named = (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
        for (const name of named) {
          if (name === "exec" || name === "execSync") {
            offenders.push(`${path.basename(file)}: import of ${name}`);
          }
        }
      }

      if (/shell\s*:\s*true/.test(content)) {
        offenders.push(`${path.basename(file)}: spawn with shell`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("explicitly sets shell: false on every spawn", () => {
    const runner = readFileSync(path.join(sourceDirectory, "runtime", "process-runner.ts"), "utf8");
    const spawns = runner.match(/spawn\(/g) ?? [];
    const explicit = runner.match(/shell:\s*false/g) ?? [];

    expect(spawns.length).toBeGreaterThan(0);
    expect(explicit.length).toBeGreaterThanOrEqual(spawns.length);
  });

  it("exposes no capability taking a command line string", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    for (const capability of harness.capabilities.declare()) {
      const properties = Object.keys(
        (capability.inputSchema?.properties as Record<string, unknown> | undefined) ?? {},
      );
      expect(properties).not.toContain("command");
      expect(properties).not.toContain("commandLine");
      expect(properties).not.toContain("script");
    }
  });

  it("does not interpret shell injection within argument array", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      arguments: { executable: "git", args: ["log", "&& del /S /Q C:\\Projets"] },
    });

    expect(result?.ok).toBe(true);
    const lastGit = harness.runner.runs.filter((r) => r.executable === "git").at(-1);
    expect(lastGit?.args).toEqual(["log", "&& del /S /Q C:\\Projets"]);
    expect(harness.runner.runs.map((r) => r.executable)).not.toContain("cmd");
  });

  it("rejects path syntax in executable argument", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      arguments: { executable: "..\\..\\Windows\\System32\\cmd.exe", args: [] },
    });

    expect(result).toMatchObject({ ok: false });
    expect(harness.runner.runs.map((r) => r.executable)).not.toContain("cmd.exe");
  });
});

describe("path traversal defenses", () => {
  it("rejects traversal in dispatched task", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: `${ALLOWED_ROOT}\\..\\Windows\\System32\\config\\SAM` },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
  });

  it("rejects absolute path outside root", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.write",
      tool: "device.filesystem.write",
      arguments: { path: "C:\\Windows\\System32\\drivers\\etc\\hosts", content: "x" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
    expect(harness.fileSystem.writes).toHaveLength(0);
  });

  it("rejects symlink traversal originating in allowed root", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.links.set(`${ALLOWED_ROOT}\\share`, "C:\\Users\\me\\Documents");
        fileSystem.files.set("C:\\Users\\me\\Documents\\taxes.pdf", "confidential");
      },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: `${ALLOWED_ROOT}\\share\\taxes.pdf` },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_NOT_ALLOWED" } });
    expect(JSON.stringify(result)).not.toContain("confidential");
  });
});

describe("unauthorized capabilities", () => {
  it("rejects capability not implemented by worker", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: {},
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("rejects locally disabled capability even if core dispatches it", async () => {
    const harness = await makeHarness({
      config: { declaredCapabilities: ["filesystem.read"] },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "process.start",
      tool: "device.process.start",
      arguments: { executable: "node", args: [] },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(harness.runner.started).toHaveLength(0);
  });

  it("refuses to stop a process not launched by NEXUS", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "process.stop",
      tool: "device.process.stop",
      arguments: { processId: 4, force: true },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "WORKER_POLICY_VIOLATION" } });
    expect(harness.runner.stopped).toHaveLength(0);
  });
});

describe("secret redaction", () => {
  it("does not log arguments in cleartext", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "filesystem.write",
      tool: "device.filesystem.write",
      arguments: {
        path: `${ALLOWED_ROOT}\\deploy.env`,
        content: "x",
        apiKey: "sk-shouldNotAppear12345",
      },
    });

    expect(harness.logger.text).not.toContain("sk-shouldNotAppear12345");
  });

  it("redacts secrets embedded within legitimate fields", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "filesystem.write",
      tool: "device.filesystem.write",
      arguments: {
        path: `${ALLOWED_ROOT}\\deploy.env`,
        content: "API_KEY=sk-realWrittenValue123456",
      },
    });

    expect(harness.logger.text).not.toContain("sk-realWrittenValue123456");
    expect(harness.logger.text).toContain("REDACTED");
    expect(harness.fileSystem.files.get(`${ALLOWED_ROOT}\\deploy.env`)).toBe(
      "API_KEY=sk-realWrittenValue123456",
    );
  });

  it("prevents process output secrets from reaching core", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.runner.outcomes.set("git", {
      stdout: "Cloning into https://user:secretpassword@github.com/a/b.git",
    });

    const result = await dispatch(harness, {
      arguments: { executable: "git", args: ["clone"] },
    });

    expect(JSON.stringify(result)).not.toContain("secretpassword");
  });

  it("never logs session tokens", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const sessionFrame = harness.link.sent.find((e) => e.type === WORKER_MESSAGE.session);
    expect(sessionFrame).toBeUndefined();
    expect(harness.logger.text).not.toMatch(/"token"/);
  });

  it("does not forward worker environment to child processes", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness);

    const gitRun = harness.runner.runs.filter((r) => r.executable === "git").at(-1);
    expect(Object.keys(gitRun?.env ?? {})).toEqual(
      expect.not.arrayContaining(["DEVICE_CREDENTIAL_PATH", "NEXUS_BACKEND_URL"]),
    );
  });

  it("does not leak denied path in core error message", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "filesystem.read",
      tool: "device.filesystem.read",
      arguments: { path: "C:\\Users\\me\\bank\\statement.pdf" },
    });

    expect(result?.error?.message).not.toContain("statement.pdf");
    expect(result?.error?.message).not.toContain("bank");
  });

  it("does not transmit technical details of unexpected internal errors", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.runner.missing.add("git");

    const result = await dispatch(harness);

    expect(result?.error?.code).toBe("WORKER_INTERNAL_ERROR");
    expect(result?.error?.message).not.toContain("ENOENT");
  });
});

describe("configuration validation", () => {
  const base = {
    NEXUS_BACKEND_URL: "wss://nexus.example.com/ws",
    DEVICE_ID: "device-1",
    DEVICE_CREDENTIAL_PATH: "C:\\ProgramData\\NEXUS\\device.key",
    WORKER_ALLOWED_PATHS: "C:\\Projets",
  };

  it("accepts complete valid configuration", () => {
    expect(loadWorkerConfig(base)).toMatchObject({
      deviceId: "device-1",
      allowedPaths: ["C:\\Projets"],
    });
  });

  it("refuses to start without device ID", () => {
    expect(() => loadWorkerConfig({ ...base, DEVICE_ID: undefined })).toThrow(
      expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }),
    );
  });

  it("rejects cleartext remote URL", () => {
    expect(() =>
      loadWorkerConfig({ ...base, NEXUS_BACKEND_URL: "ws://nexus.example.com/ws" }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("permits cleartext local URL for development", () => {
    expect(() =>
      loadWorkerConfig({ ...base, NEXUS_BACKEND_URL: "ws://localhost:3000/ws" }),
    ).not.toThrow();
  });

  it("references private key by path only", () => {
    const config = loadWorkerConfig(base);
    expect(config.credentialPath).toBe("C:\\ProgramData\\NEXUS\\device.key");
    expect(JSON.stringify(config)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("rejects inconsistent reconnect intervals", () => {
    expect(() =>
      loadWorkerConfig({
        ...base,
        WORKER_RECONNECT_MIN_MS: "60000",
        WORKER_RECONNECT_MAX_MS: "5000",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("defaults Docker permissions to read-only", () => {
    expect(loadWorkerConfig(base).dockerAllowed).toEqual(["ps", "images", "logs", "inspect"]);
  });

  it("defaults Git write operations to false", () => {
    expect(loadWorkerConfig(base).gitAllowWrite).toBe(false);
  });

  it("accepts local inference only on the worker loopback interface", () => {
    expect(
      loadWorkerConfig({
        ...base,
        WORKER_LLM_RUNTIME: "ollama",
        WORKER_LLM_URL: "http://127.0.0.1:11434",
        WORKER_LLM_MODEL: "qwen3:14b",
      }).localLlm,
    ).toMatchObject({ runtime: "ollama", model: "qwen3:14b" });

    expect(() =>
      loadWorkerConfig({
        ...base,
        WORKER_LLM_RUNTIME: "openai-compatible",
        WORKER_LLM_URL: "http://192.168.1.40:8000",
        WORKER_LLM_MODEL: "private-model",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });
});

describe("no secrets in repository", () => {
  it(".env.example file contains placeholders only", () => {
    const example = readFileSync(
      path.join(fileURLToPath(new URL(".", import.meta.url)), "..", ".env.example"),
      "utf8",
    );

    expect(example).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(example).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
    expect(example).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
    expect(example).toMatch(/DEVICE_CREDENTIAL_PATH=/);
  });
});
