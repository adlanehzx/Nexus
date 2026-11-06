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
    expect(blockedSandbox.getIsolationStatus()).toMatchObject({
      supported: false,
      status: "blocked",
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
    expect(vmSandbox.getIsolationStatus()).toMatchObject({
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

  it("demonstrates plugin cannot read /etc/passwd or host vault files (SEC-01 Filesystem Confinement)", async () => {
    const sandbox = new PluginSandbox({
      mode: "subprocess",
      skipStaticChecks: true,
    });

    const status = sandbox.getIsolationStatus();
    if (status.status !== "isolated") {
      // If bwrap is not supported in this environment, this test will skip OS verification
      return;
    }

    const context = {
      pluginId: "plugin-fs-confinement",
      injectedSecrets: {},
      allowedEgress: [],
    };

    const code = `
      result = {
        passwd: probe.readHostFile("/etc/passwd"),
        vault: probe.readHostFile("/home/adlane/.nexus/vault.json")
      };
    `;

    const outcome = (await sandbox.executeToolHandler("fs_tool", code, {}, context)) as {
      passwd: string;
      vault: string;
    };

    expect(outcome.passwd).toBe("ERROR:EACCES");
    expect(outcome.vault).toBe("ERROR:ENOENT");
  });

  it("demonstrates plugin cannot open outbound network connections (SEC-01 Network Confinement)", async () => {
    const sandbox = new PluginSandbox({
      mode: "subprocess",
      skipStaticChecks: true,
      timeoutMs: 2000,
    });

    const status = sandbox.getIsolationStatus();
    if (status.status !== "isolated") {
      return;
    }

    const context = {
      pluginId: "plugin-net-confinement",
      injectedSecrets: {},
      allowedEgress: [],
    };

    const code = `
      result = {
        egress: probe.testEgress("1.1.1.1", 80)
      };
    `;

    const outcome = (await sandbox.executeToolHandler("net_tool", code, {}, context)) as {
      egress: string;
    };

    expect(outcome.egress).toContain("ENETUNREACH");
  });

  it("demonstrates plugin cannot list host processes (SEC-01 PID Namespace Confinement)", async () => {
    const sandbox = new PluginSandbox({
      mode: "subprocess",
      skipStaticChecks: true,
    });

    const status = sandbox.getIsolationStatus();
    if (status.status !== "isolated") {
      return;
    }

    const context = {
      pluginId: "plugin-pid-confinement",
      injectedSecrets: {},
      allowedEgress: [],
    };

    const code = `
      result = {
        pids: probe.listProcPids()
      };
    `;

    const outcome = (await sandbox.executeToolHandler("pid_tool", code, {}, context)) as {
      pids: string[];
    };

    expect(Array.isArray(outcome.pids)).toBe(true);
    // Container sees only its own namespace processes (typically 1 and 2), not hundreds of host PIDs
    expect(outcome.pids.length).toBeLessThanOrEqual(5);
  });

  it("demonstrates fail-closed refusal when isolation backend binary is absent (SEC-01 Fail-Closed)", async () => {
    const missingBwrapSandbox = new PluginSandbox({
      mode: "subprocess",
      bwrapPath: "/usr/bin/bwrap-nonexistent-path-for-testing",
    });

    expect(missingBwrapSandbox.getIsolationStatus()).toMatchObject({
      supported: false,
      status: "unsupported",
      backend: "none",
    });

    // Untrusted execution MUST be refused immediately without any unconfined fallback
    await expect(
      missingBwrapSandbox.executeToolHandler(
        "untrusted_tool",
        "result = 'should_never_run'",
        {},
        {
          pluginId: "untrusted-plugin-fail-closed",
          untrusted: true,
          injectedSecrets: {},
          allowedEgress: [],
        },
      ),
    ).rejects.toThrow(/UNSUPPORTED_ISOLATION_ENVIRONMENT/);
  });
});
