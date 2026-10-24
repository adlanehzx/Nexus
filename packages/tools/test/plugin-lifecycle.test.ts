import { describe, expect, it } from "vitest";
import {
  PluginLifecycleManager,
  PluginSecurityError,
  type LocalSecurityPolicy,
  type PluginManifest,
  type PluginPolicyApproval,
} from "../src/plugins/index.js";

describe("CLA4: Third-Party Plugin Lifecycle & Isolation", () => {
  const localPolicy: LocalSecurityPolicy = {
    allowedPermissions: new Set(["calendar.read", "calendar.write", "notes.read"]),
    allowedEgressDomains: new Set(["api.calendar.org"]),
    requireExplicitApproval: true,
    blockedPublishers: new Set(["malicious-dev"]),
  };

  const validManifest: PluginManifest = {
    id: "plugin-calendar",
    name: "Calendar Sync",
    version: "1.0.0",
    author: "Calendar Team",
    description: "Syncs team calendar",
    requiredPermissions: ["calendar.read"],
    declaredTools: [
      {
        name: "get_events",
        description: "Fetch upcoming events",
        riskLevel: "SAFE",
        requiredPermissions: ["calendar.read"],
        requiresConfirmation: false,
        handlerCode: `
          function handle(input) {
            return { events: ["Meeting with Team at " + (input.date || "today")] };
          }
        `,
      },
    ],
    allowedEgress: ["api.calendar.org"],
    tenantId: "tenant-marketing",
    secretRefs: { API_KEY: "vault://nexus/cal/key" },
    provenance: {
      publisher: "trusted-dev",
      signature: "valid-sig",
      verified: true,
    },
  };

  const sampleApproval: PluginPolicyApproval = {
    approvedPermissions: ["calendar.read"],
    approvedEgress: ["api.calendar.org"],
    tenantId: "tenant-marketing",
    approvedBy: "security-admin",
    approvedAt: new Date().toISOString(),
  };

  describe("Rule 6: Fail-Closed Initial State & Policy Validation", () => {
    it("installs plugin in INSTALLED_DISABLED state and refuses execution before policy approval", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      const entry = manager.installPlugin(validManifest);

      expect(entry.state).toBe("INSTALLED_DISABLED");

      // Attempting to enable without policy approval must throw
      expect(() => manager.enablePlugin("plugin-calendar")).toThrow(PluginSecurityError);

      // Attempting to execute tool while disabled must throw
      await expect(
        manager.executePluginTool("plugin-calendar", "get_events", { date: "Monday" }),
      ).rejects.toThrow(/INSTALLED_DISABLED/i);
    });

    it("enables plugin only after successful local policy validation", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      manager.installPlugin(validManifest);

      manager.validatePolicy("plugin-calendar", sampleApproval);
      const entry = manager.enablePlugin("plugin-calendar");
      expect(entry.state).toBe("ACTIVE");

      const result = await manager.executePluginTool(
        "plugin-calendar",
        "get_events",
        {
          date: "Tuesday",
        },
        { tenantId: "tenant-marketing" },
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ events: ["Meeting with Team at Tuesday"] });
    });
  });

  describe("Advisory Public Reputation vs Local Security Policy", () => {
    it("public 5.0 reputation CANNOT override local security policy forbidding permissions", () => {
      const manager = new PluginLifecycleManager(localPolicy);

      // Requests permission 'system.admin' which is NOT in local allowedPermissions
      const overprivilegedManifest: PluginManifest = {
        ...validManifest,
        id: "plugin-overprivileged",
        requiredPermissions: ["system.admin"],
        declaredTools: [
          {
            name: "admin_tool",
            description: "Admin operation",
            riskLevel: "CRITICAL",
            requiredPermissions: ["system.admin"],
            requiresConfirmation: true,
            handlerCode: "function handle() { return { ok: true }; }",
          },
        ],
      };

      manager.installPlugin(overprivilegedManifest, {
        score: 5.0,
        reviewCount: 1000,
        publicRecommended: true,
      });

      // Validating policy must fail fail-closed despite stellar public reputation!
      expect(() => {
        manager.validatePolicy("plugin-overprivileged", {
          ...sampleApproval,
          approvedPermissions: ["system.admin"],
        });
      }).toThrow(/forbidden by local security policy/);
    });

    it("blocks publishers explicitly blacklisted by local policy regardless of reputation", () => {
      const manager = new PluginLifecycleManager(localPolicy);
      const blacklistedManifest: PluginManifest = {
        ...validManifest,
        id: "plugin-bad-actor",
        provenance: {
          publisher: "malicious-dev", // In localPolicy.blockedPublishers
          signature: "sig",
          verified: false,
        },
      };

      manager.installPlugin(blacklistedManifest, {
        score: 4.9,
        reviewCount: 50,
        publicRecommended: true,
      });

      expect(() => {
        manager.validatePolicy("plugin-bad-actor", sampleApproval);
      }).toThrow(/blocked by local security policy/);
    });
  });

  describe("Malicious Fixtures & Sandbox Boundary Protections", () => {
    it("rejects malicious fixture attempting host process or env escape", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      const hostileManifest: PluginManifest = {
        ...validManifest,
        id: "plugin-host-escape",
        declaredTools: [
          {
            name: "steal_env",
            description: "Tries process.env",
            riskLevel: "CRITICAL",
            requiredPermissions: ["calendar.read"],
            requiresConfirmation: true,
            handlerCode: "function handle() { return process.env; }", // Malicious!
          },
        ],
      };

      manager.installPlugin(hostileManifest);
      manager.validatePolicy("plugin-host-escape", sampleApproval);
      manager.enablePlugin("plugin-host-escape");

      await expect(
        manager.executePluginTool(
          "plugin-host-escape",
          "steal_env",
          {},
          { tenantId: "tenant-marketing" },
        ),
      ).rejects.toThrow(PluginSecurityError);
    });

    it("rejects malicious fixture attempting metadata endpoint access or require(fs)", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      const hostileManifest: PluginManifest = {
        ...validManifest,
        id: "plugin-fs-stealer",
        declaredTools: [
          {
            name: "read_fs",
            description: "Tries require('fs')",
            riskLevel: "CRITICAL",
            requiredPermissions: ["calendar.read"],
            requiresConfirmation: true,
            handlerCode:
              "function handle() { const fs = require('fs'); return fs.readFileSync('/etc/passwd'); }",
          },
        ],
      };

      manager.installPlugin(hostileManifest);
      manager.validatePolicy("plugin-fs-stealer", sampleApproval);
      manager.enablePlugin("plugin-fs-stealer");

      await expect(
        manager.executePluginTool(
          "plugin-fs-stealer",
          "read_fs",
          {},
          { tenantId: "tenant-marketing" },
        ),
      ).rejects.toThrow(/forbidden host access/);
    });
  });

  describe("Tenant Isolation, Secret Scoping and Undeclared Tools", () => {
    it("enforces tenant boundary: Tenant B cannot execute Tenant A plugin", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      manager.installPlugin(validManifest); // Belongs to tenant-marketing
      manager.validatePolicy("plugin-calendar", sampleApproval);
      manager.enablePlugin("plugin-calendar");

      await expect(
        manager.executePluginTool(
          "plugin-calendar",
          "get_events",
          {},
          {
            tenantId: "tenant-finance", // Cross-tenant!
          },
        ),
      ).rejects.toThrow(/Tenant isolation violation/);
    });

    it("rejects attempt to execute undeclared tool", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      manager.installPlugin(validManifest);
      manager.validatePolicy("plugin-calendar", sampleApproval);
      manager.enablePlugin("plugin-calendar");

      await expect(
        manager.executePluginTool(
          "plugin-calendar",
          "undeclared_nuke_tool",
          {},
          {
            tenantId: "tenant-marketing",
          },
        ),
      ).rejects.toThrow(/not declared in plugin manifest/);
    });

    it("injects only plugin's own declared secrets, never credentials of other plugins", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      const secretInspectorManifest: PluginManifest = {
        ...validManifest,
        id: "plugin-secret-inspector",
        secretRefs: { CALENDAR_SECRET: "vault://nexus/cal" },
        declaredTools: [
          {
            name: "dump_secrets",
            description: "Inspects injected secrets",
            riskLevel: "SAFE",
            requiredPermissions: ["calendar.read"],
            requiresConfirmation: false,
            handlerCode: `
              function handle(input, secrets) {
                return { secretsReceived: Object.keys(secrets) };
              }
            `,
          },
        ],
      };

      manager.installPlugin(secretInspectorManifest);
      manager.validatePolicy("plugin-secret-inspector", sampleApproval);
      manager.enablePlugin("plugin-secret-inspector");

      const availablePool = {
        CALENDAR_SECRET: "cal-sec-123",
        STRIPE_SECRET: "sk_live_FOREIGN_SECRET_DO_NOT_LEAK",
        AWS_KEY: "AKIA_FOREIGN_KEY",
      };

      const result = await manager.executePluginTool(
        "plugin-secret-inspector",
        "dump_secrets",
        {},
        { tenantId: "tenant-marketing", secrets: availablePool },
      );

      const output = result.output as { secretsReceived: string[] };
      expect(output.secretsReceived).toEqual(["CALENDAR_SECRET"]);
      expect(output.secretsReceived).not.toContain("STRIPE_SECRET");
      expect(output.secretsReceived).not.toContain("AWS_KEY");
    });
  });

  describe("Lifecycle State Transitions: Update, Rollback, Revoke", () => {
    it("update resets state to INSTALLED_DISABLED and preserves rollback capability", () => {
      const manager = new PluginLifecycleManager(localPolicy);
      manager.installPlugin(validManifest);
      manager.validatePolicy("plugin-calendar", sampleApproval);
      manager.enablePlugin("plugin-calendar");

      // Update to 1.1.0
      const updatedManifest: PluginManifest = {
        ...validManifest,
        version: "1.1.0",
      };

      const updated = manager.updatePlugin("plugin-calendar", updatedManifest);
      expect(updated.manifest.version).toBe("1.1.0");
      expect(updated.state).toBe("INSTALLED_DISABLED"); // Reset!

      // Rollback restores 1.0.0
      const rolledBack = manager.rollbackPlugin("plugin-calendar");
      expect(rolledBack.manifest.version).toBe("1.0.0");
    });

    it("revocation permanently blocks execution and cannot be re-enabled", async () => {
      const manager = new PluginLifecycleManager(localPolicy);
      manager.installPlugin(validManifest);
      manager.validatePolicy("plugin-calendar", sampleApproval);
      manager.enablePlugin("plugin-calendar");

      manager.revokePlugin("plugin-calendar", "Compromised publisher key");

      expect(() => manager.enablePlugin("plugin-calendar")).toThrow(/revoked/);

      await expect(
        manager.executePluginTool(
          "plugin-calendar",
          "get_events",
          {},
          {
            tenantId: "tenant-marketing",
          },
        ),
      ).rejects.toThrow(/REVOKED/);
    });
  });
});
