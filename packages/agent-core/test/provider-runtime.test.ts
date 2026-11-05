import { describe, it, expect, vi } from "vitest";
import {
  ClaudeProviderDriver,
  CodexProviderDriver,
  AntigravityProviderDriver,
  CursorProviderDriver,
  GrokProviderDriver,
  OpenCodeProviderDriver,
  PiProviderDriver,
  AcpProviderDriver,
  LocalProviderDriver,
  RealAcpClient,
  type RealAcpTransport,
  ProviderRegistry,
  ProviderInstance,
} from "../src/index.js";

describe("Next-Gen Provider Runtime (LOT C)", () => {
  describe("Coverage of 9 Priority Providers", () => {
    it("instantiates and validates capabilities for all 9 priority providers", async () => {
      const drivers = [
        new ClaudeProviderDriver(),
        new CodexProviderDriver(),
        new AntigravityProviderDriver(),
        new CursorProviderDriver(),
        new GrokProviderDriver(),
        new OpenCodeProviderDriver(),
        new PiProviderDriver(),
        new AcpProviderDriver(),
        new LocalProviderDriver(),
      ];

      expect(drivers).toHaveLength(9);

      const ids = drivers.map((d) => d.id);
      expect(ids).toContain("claude");
      expect(ids).toContain("codex");
      expect(ids).toContain("antigravity");
      expect(ids).toContain("cursor");
      expect(ids).toContain("grok");
      expect(ids).toContain("opencode");
      expect(ids).toContain("pi");
      expect(ids).toContain("acp");
      expect(ids).toContain("local");

      for (const driver of drivers) {
        expect(driver.displayName).toBeDefined();
        expect(driver.capabilities).toBeDefined();
        const models = await driver.listModels();
        expect(models.length).toBeGreaterThan(0);
      }
    });

    it("enforces strict credential validation without fakes across providers", async () => {
      const codex = new CodexProviderDriver();
      expect(await codex.validateCredentials({})).toEqual(
        expect.objectContaining({ valid: false }),
      );
      expect(await codex.validateCredentials({ apiKey: "sk-short" })).toEqual(
        expect.objectContaining({ valid: false }),
      );
      expect(await codex.validateCredentials({ apiKey: "sk-proj-valid-length-api-key" })).toEqual({
        valid: true,
      });

      const antigravity = new AntigravityProviderDriver();
      expect(await antigravity.validateCredentials({})).toEqual(
        expect.objectContaining({ valid: false }),
      );
      expect(await antigravity.validateCredentials({ apiKey: "valid-antigravity-key" })).toEqual({
        valid: true,
      });

      const opencode = new OpenCodeProviderDriver();
      expect(await opencode.validateCredentials({})).toEqual(
        expect.objectContaining({ valid: false }),
      );

      const pi = new PiProviderDriver();
      expect(await pi.validateCredentials({})).toEqual(expect.objectContaining({ valid: false }));
    });
  });

  describe("ProviderRegistry & Multi-Instance Management", () => {
    it("registers drivers and instances, selecting best instance by priority and health", async () => {
      const registry = new ProviderRegistry();
      const codexDriver = new CodexProviderDriver();
      registry.registerDriver(codexDriver);

      const instance1 = new ProviderInstance(codexDriver, {
        instanceId: "codex-primary",
        providerType: "codex",
        displayName: "Codex Fast Primary",
        priority: 1,
        enabled: true,
      });

      const instance2 = new ProviderInstance(codexDriver, {
        instanceId: "codex-backup",
        providerType: "codex",
        displayName: "Codex Secondary Backup",
        priority: 2,
        enabled: true,
      });

      registry.registerInstance(instance1);
      registry.registerInstance(instance2);

      // Best instance initially is priority 1
      let best = await registry.resolveBestInstance("codex");
      expect(best?.id).toBe("codex-primary");

      // Record failures on primary to trigger cooldown
      instance1.recordFailure();
      instance1.recordFailure();
      instance1.recordFailure(5000); // 3 failures -> cooling_down

      expect(instance1.isAvailable()).toBe(false);

      // Best instance fails over to priority 2
      best = await registry.resolveBestInstance("codex");
      expect(best?.id).toBe("codex-backup");
    });
  });

  describe("Real Typed ACP Client (JSON-RPC 2.0)", () => {
    it("completes protocol handshake with negotiation and reports honest errors", async () => {
      let messageHandler: ((line: string) => void) | null = null;
      let sentPayload: string | null = null;

      const mockTransport: RealAcpTransport = {
        send: vi.fn().mockImplementation(async (msg: string) => {
          await Promise.resolve();
          sentPayload = msg;
          const parsed = JSON.parse(msg);
          if (parsed.method === "initialize") {
            setTimeout(() => {
              messageHandler?.(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: {
                    protocolVersion: 2,
                    serverInfo: { name: "test-acp-server", version: "1.0.0" },
                    capabilities: {
                      streaming: true,
                      toolCall: true,
                      sessionResumption: true,
                      contextWindow: 128000,
                    },
                  },
                }),
              );
            }, 5);
          }
        }),
        onMessage: vi.fn().mockImplementation((handler) => {
          messageHandler = handler;
        }),
        onError: vi.fn(),
        onClose: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const client = new RealAcpClient(mockTransport);
      expect(client.getStatus().state).toBe("disconnected");

      const capabilities = await client.initialize();
      expect(capabilities.protocolVersion).toBe(2);
      expect(capabilities.streaming).toBe(true);
      expect(capabilities.sessionResumption).toBe(true);
      expect(client.getStatus().state).toBe("connected");
      expect(sentPayload).toContain('"method":"initialize"');
    });

    it("marks status as unreachable when transport fails instead of inventing fake turns", async () => {
      const mockTransport: RealAcpTransport = {
        send: vi.fn().mockRejectedValue(new Error("Connection refused (ECONNREFUSED)")),
        onMessage: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const client = new RealAcpClient(mockTransport);

      await expect(client.initialize()).rejects.toThrow("Connection refused");
      expect(client.getStatus().state).toBe("unreachable");
    });
  });
});
