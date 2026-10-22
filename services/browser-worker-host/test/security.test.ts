import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerConfigurationError } from "@nexus/worker-core";
import { describeConfig, loadBrowserHostConfig } from "../src/config.js";
import { toSocketUrl } from "../src/connection/link.js";
import { BROWSER_TOKEN, makeHarness, testConfig } from "./fixtures.js";

/**
 * Security properties of the browser worker stated as executable tests.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Strip comments to inspect code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const BASE = {
  NEXUS_BACKEND_URL: "wss://nexus.example.com",
  DEVICE_ID: "device-browser",
  DEVICE_KEY_PATH: "/secrets/device.pem",
  BROWSER_WORKER_TOKEN: BROWSER_TOKEN,
};

// ─────────────────────────────────────────────────────────────────────────────
// Execution surface
// ─────────────────────────────────────────────────────────────────────────────

describe("execution surface", () => {
  it("does not expose command execution or disk access", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/child_process|execSync|spawnSync|\bexec\(|ProcessBuilder/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not read or write files outside device key", () => {
    const readers: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/node:fs|writeFile|readFile|createWriteStream/.test(content)) {
        readers.push(path.relative(ROOT, file).replace(/\\/g, "/"));
      }
    }

    expect(readers).toEqual(["src/connection/link.ts"]);
  });

  it("declares no capabilities outside browser domain", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const registered = harness.link.sent.find((envelope) => envelope.type === "worker.register");
    const payload = registered?.payload as { capabilities: { name: string }[] };

    expect(payload.capabilities.length).toBeGreaterThan(0);
    for (const capability of payload.capabilities) {
      expect(capability.name.startsWith("browser.")).toBe(true);
    }
  });

  it("does not listen on any port", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/\.listen\(|createServer|WebSocketServer/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authentication and identity
// ─────────────────────────────────────────────────────────────────────────────

describe("authentication", () => {
  it("uses no shared secret with core", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const authenticate = harness.link.sent.find(
      (envelope) => envelope.type === "worker.authenticate",
    );
    const payload = authenticate?.payload as { signature?: string; nonce?: string };

    expect(payload.signature).toBeTruthy();
    expect(JSON.stringify(harness.link.sent)).not.toContain(BROWSER_TOKEN);
  });

  it("never transmits Python worker token to core", async () => {
    const harness = await makeHarness();
    await harness.connect();

    expect(JSON.stringify(harness.link.sent)).not.toContain("Bearer");
    expect(JSON.stringify(harness.link.sent)).not.toContain(BROWSER_TOKEN);
  });

  it("requires a service token of meaningful length", () => {
    expect(() => loadBrowserHostConfig({ ...BASE, BROWSER_WORKER_TOKEN: "short" })).toThrow(
      WorkerConfigurationError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

describe("secrets", () => {
  it("diagnostic output yields no secret values", () => {
    const description = describeConfig(
      testConfig({ browserWorkerToken: "a-very-secret-and-long-token" }),
    );
    const serialised = JSON.stringify(description);

    expect(serialised).not.toContain("a-very-secret-and-long-token");
    expect(serialised).not.toContain("/nonexistent/device.pem");
    expect(description.browserWorkerToken).toBe("[set]");
  });

  it("no secrets hardcoded in source files", () => {
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
      expect(content).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });

  it("key path never appears in error messages", () => {
    const description = describeConfig(testConfig());
    expect(Object.values(description)).not.toContain("/nonexistent/device.pem");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Networking
// ─────────────────────────────────────────────────────────────────────────────

describe("networking", () => {
  it("rejects cleartext remote link to core", () => {
    expect(() =>
      loadBrowserHostConfig({ ...BASE, NEXUS_BACKEND_URL: "http://nexus.example.com" }),
    ).toThrow(WorkerConfigurationError);
    expect(() => toSocketUrl("ws://nexus.example.com", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });

  it("permits loopback where nothing leaves the machine", () => {
    expect(toSocketUrl("http://localhost:3000", "/ws/worker")).toBe(
      "ws://localhost:3000/ws/worker",
    );
  });

  it("rejects cleartext public address for Python worker", () => {
    expect(() =>
      loadBrowserHostConfig({ ...BASE, BROWSER_WORKER_URL: "http://browser.example.com" }),
    ).toThrow(WorkerConfigurationError);
  });

  it("accepts internal service name", () => {
    const config = loadBrowserHostConfig({
      ...BASE,
      BROWSER_WORKER_URL: "http://browser-worker:8100",
    });
    expect(config.browserWorkerUrl).toBe("http://browser-worker:8100");
  });

  it("rejects exotic protocol", () => {
    expect(() => toSocketUrl("file:///etc/passwd", "/ws/worker")).toThrow(WorkerConfigurationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Navigation policy
// ─────────────────────────────────────────────────────────────────────────────

describe("navigation policy", () => {
  it("is not reimplemented in host", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/EXCLUDED_ACTIONS|excludedActions|ALWAYS_EXCLUDED|isDomainAllowed/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("forwards intent as-is without reclassifying", async () => {
    const harness = await makeHarness();
    await harness.connect();

    const { assembleBrowserHost } = await import("../src/assemble.js");
    const { capabilities } = assembleBrowserHost({
      config: testConfig(),
      client: harness.client,
    });

    await capabilities.require("browser.purchase").execute({ instructions: "purchase" } as never, {
      taskId: "t",
      stepId: "s",
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      onProgress: () => undefined,
    });

    expect(harness.python.launched.at(-1)?.intent).toBe("purchase");
  });
});
