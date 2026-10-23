import { describe, expect, it } from "vitest";
import { detectTailscale, type CommandExecutor } from "../src/tailscale.js";

describe("detectTailscale", () => {
  it("reports uninstalled when tailscale CLI is missing", async () => {
    const mockExec: CommandExecutor = () =>
      Promise.resolve({
        stdout: "",
        stderr: "command not found: tailscale",
        exitCode: 127,
      });

    const info = await detectTailscale(mockExec, 3000);
    expect(info.installed).toBe(false);
    expect(info.running).toBe(false);
    expect(info.suggestedUrl).toBeUndefined();
    expect(info.guidance).toContain("Tailscale is not installed");
  });

  it("reports stopped when tailscale is installed but daemon is offline", async () => {
    const mockExec: CommandExecutor = (_cmd, args) => {
      if (args[0] === "version") {
        return Promise.resolve({ stdout: "1.74.0", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "Tailscale is stopped", exitCode: 1 });
    };

    const info = await detectTailscale(mockExec, 3000);
    expect(info.installed).toBe(true);
    expect(info.running).toBe(false);
    expect(info.guidance).toContain("Tailscale service is stopped");
  });

  it("detects running tailnet node and formats suggested PUBLIC_API_URL", async () => {
    const mockExec: CommandExecutor = (_cmd, args) => {
      if (args[0] === "version") {
        return Promise.resolve({ stdout: "1.74.0", stderr: "", exitCode: 0 });
      }
      if (args[0] === "status") {
        return Promise.resolve({
          stdout: JSON.stringify({
            Self: {
              HostName: "test-node",
              DNSName: "test-node.example-tailnet.ts.net.",
              TailscaleIPs: ["100.64.12.34", "fd7a:115c:a1e0::1"],
            },
            MagicDNSSuffix: "example-tailnet.ts.net",
          }),
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    };

    const info = await detectTailscale(mockExec, 3000);
    expect(info.installed).toBe(true);
    expect(info.running).toBe(true);
    expect(info.ip).toBe("100.64.12.34");
    expect(info.dnsName).toBe("test-node.example-tailnet.ts.net");
    expect(info.suggestedUrl).toBe("http://100.64.12.34:3000");
    expect(info.guidance).toContain("Tailscale connection active");
  });

  it("falls back to tailscale ip -4 if json parse fails", async () => {
    const mockExec: CommandExecutor = (_cmd, args) => {
      if (args[0] === "version") {
        return Promise.resolve({ stdout: "1.74.0", stderr: "", exitCode: 0 });
      }
      if (args[0] === "status") {
        return Promise.resolve({ stdout: "not valid json", stderr: "", exitCode: 0 });
      }
      if (args[0] === "ip") {
        return Promise.resolve({ stdout: "100.77.88.99\n", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    };

    const info = await detectTailscale(mockExec, 3000);
    expect(info.installed).toBe(true);
    expect(info.running).toBe(true);
    expect(info.ip).toBe("100.77.88.99");
    expect(info.suggestedUrl).toBe("http://100.77.88.99:3000");
  });
});
