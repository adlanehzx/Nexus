import { describe, expect, it } from "vitest";
import { PluginSandbox, PluginSecurityError } from "../src/plugins/sandbox.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SEC-01: Subprocess Process-Isolated Plugin Sandbox", () => {
  it("terminates hanging execution via timeout and SIGKILL", async () => {
    const sandbox = new PluginSandbox({
      mode: "subprocess",
      timeoutMs: 300,
    });

    const context = {
      pluginId: "plugin-hang",
      injectedSecrets: {},
      allowedEgress: [],
    };

    // Infinite loop in handler
    const hangCode = "while (true) {}";

    await expect(sandbox.executeToolHandler("hang_tool", hangCode, {}, context)).rejects.toThrow(
      PluginSecurityError,
    );
  });

  it("fails on host escape attempt and refuses to access host process", async () => {
    const sandbox = new PluginSandbox({ mode: "subprocess" });
    const context = {
      pluginId: "plugin-escape",
      injectedSecrets: {},
      allowedEgress: [],
    };

    // Attempting process.exit or child_process
    await expect(
      sandbox.executeToolHandler("escape_tool", "child_process.execSync('whoami')", {}, context),
    ).rejects.toThrow(/forbidden host access/i);
  });

  it("prevents reading host files outside the isolated jail directory", async () => {
    const jailDir = await mkdtemp(join(tmpdir(), "nexus-jail-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "nexus-outside-"));
    const secretHostFile = join(outsideDir, "host-secret.txt");
    await writeFile(secretHostFile, "CLASSIFIED_HOST_DATA");

    try {
      const sandbox = new PluginSandbox({
        mode: "subprocess",
        isolatedDir: jailDir,
      });

      const context = {
        pluginId: "plugin-jail-break",
        injectedSecrets: {},
        allowedEgress: [],
      };

      // Attempt to read outside file
      const jailBreakCode = `
        const fs = require("node:fs");
        result = fs.readFileSync(${JSON.stringify(secretHostFile)}, "utf8");
      `;

      await expect(
        sandbox.executeToolHandler("jail_tool", jailBreakCode, {}, context),
      ).rejects.toThrow();
    } finally {
      await rm(jailDir, { recursive: true, force: true }).catch(() => {
        void 0;
      });
      await rm(outsideDir, { recursive: true, force: true }).catch(() => {
        void 0;
      });
    }
  });

  it("safely degrades and blocks untrusted plugins when OS isolation is unavailable or blocked", async () => {
    const blockedSandbox = new PluginSandbox({ mode: "blocked" });
    expect(blockedSandbox.getIsolationStatus()).toEqual({
      supported: false,
      mode: "blocked",
      reason: "Plugin execution is explicitly blocked by policy.",
    });

    await expect(
      blockedSandbox.executeToolHandler(
        "test",
        "result = 1",
        {},
        {
          pluginId: "plugin-untrusted",
          untrusted: true,
          injectedSecrets: {},
          allowedEgress: [],
        },
      ),
    ).rejects.toThrow(/execution blocked/i);

    // Regular plugin on blocked mode triggers blocked by sandbox policy
    await expect(
      blockedSandbox.executeToolHandler(
        "test",
        "result = 1",
        {},
        {
          pluginId: "plugin-trusted",
          untrusted: false,
          injectedSecrets: {},
          allowedEgress: [],
        },
      ),
    ).rejects.toThrow(/blocked by sandbox policy/i);

    const vmSandbox = new PluginSandbox({ mode: "vm", allowUntrustedWithoutIsolation: false });
    expect(vmSandbox.getIsolationStatus()).toEqual({
      supported: true,
      mode: "vm",
    });

    await expect(
      vmSandbox.executeToolHandler(
        "test",
        "result = 1",
        {},
        {
          pluginId: "plugin-untrusted-vm",
          untrusted: true,
          injectedSecrets: {},
          allowedEgress: [],
        },
      ),
    ).rejects.toThrow(/Untrusted plugin 'plugin-untrusted-vm' execution blocked/i);
  });
});
