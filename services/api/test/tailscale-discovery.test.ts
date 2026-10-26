import { describe, expect, it, vi } from "vitest";
import { TailscaleDiscoveryService } from "../src/services/tailscale-discovery.js";

describe("TailscaleDiscoveryService", () => {
  it("returns a secret-free peer inventory and automatic API address", async () => {
    const run = vi.fn((_command: string, args: readonly string[]) => {
      if (args[0] === "version") return Promise.resolve({ stdout: "1.102.3\n" });
      return Promise.resolve({
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "example.ts.net",
          Self: {
            ID: "self-id",
            HostName: "nexus-host",
            DNSName: "nexus-host.example.ts.net.",
            OS: "linux",
            Online: true,
            TailscaleIPs: ["100.64.0.10"],
          },
          Peer: {
            nodeKey: {
              ID: "iphone-id",
              HostName: "phone",
              OS: "iOS",
              Online: true,
              Active: false,
              TailscaleIPs: ["100.64.0.20"],
            },
          },
        }),
      });
    });

    const discovery = await new TailscaleDiscoveryService({ run, apiPort: 3000 }).inspect();

    expect(discovery).toMatchObject({
      installed: true,
      running: true,
      suggestedApiUrl: "http://nexus-host.example.ts.net:3000",
      self: { name: "nexus-host", ipv4: "100.64.0.10" },
      peers: [{ id: "iphone-id", name: "phone", os: "iOS", online: true }],
    });
    expect(JSON.stringify(discovery)).not.toMatch(/token|key|credential/i);
    expect(run).toHaveBeenNthCalledWith(1, "tailscale", ["version"]);
    expect(run).toHaveBeenNthCalledWith(2, "tailscale", ["status", "--json"]);
  });

  it("reports an unavailable installation without throwing", async () => {
    const service = new TailscaleDiscoveryService({
      run: async () => Promise.reject(new Error("ENOENT")),
    });

    await expect(service.inspect()).resolves.toEqual({
      installed: false,
      running: false,
      backendState: "NotInstalled",
      peers: [],
      guidance: "Install Tailscale on the NEXUS host to discover private-network devices.",
    });
  });
});
