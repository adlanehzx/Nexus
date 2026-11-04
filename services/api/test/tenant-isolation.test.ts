import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@nexus/database";
import {
  TenantSecurityService,
  TenantIsolationError,
  type TenantContext,
} from "../src/services/tenant-security.js";

describe("Multi-Tenant Isolation Architecture (LOT B)", () => {
  it("provisions personal tenant and default workspace automatically for individual user", async () => {
    const mockCreatedOrg: any = {};
    const mockPrisma = {
      organizationMembership: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      organization: {
        create: vi.fn().mockImplementation((args) => {
          Object.assign(mockCreatedOrg, args.data);
          return Promise.resolve(mockCreatedOrg);
        }),
      },
      workspace: {
        create: vi.fn(),
      },
    } as unknown as PrismaClient;

    const security = new TenantSecurityService(mockPrisma);
    const result = await security.ensurePersonalTenant("user-1234", "alice@example.com");

    expect(result.organizationId).toBeDefined();
    expect(result.workspaceId).toBeDefined();
    expect(mockPrisma.organization.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: expect.stringContaining("personal-user-123"),
          name: "Personal (alice)",
          mode: "LOCAL",
        }),
      }),
    );
  });

  it("reuses existing tenant and workspace when already provisioned", async () => {
    const mockPrisma = {
      organizationMembership: {
        findFirst: vi.fn().mockResolvedValue({
          organization: {
            id: "org-existing-456",
            workspaces: [
              { id: "ws-default-789", isDefault: true, name: "Default Workspace" },
            ],
          },
        }),
      },
    } as unknown as PrismaClient;

    const security = new TenantSecurityService(mockPrisma);
    const result = await security.ensurePersonalTenant("user-existing", "bob@example.com");

    expect(result.organizationId).toBe("org-existing-456");
    expect(result.workspaceId).toBe("ws-default-789");
  });

  it("prevents cross-tenant access to workspaces, projects, and missions", async () => {
    const mockPrisma = {
      workspace: {
        findUnique: vi.fn().mockResolvedValue({
          id: "ws-victim",
          organizationId: "org-victim",
        }),
      },
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "proj-victim",
          workspace: { organizationId: "org-victim" },
        }),
      },
      tenantMission: {
        findUnique: vi.fn().mockResolvedValue({
          id: "mission-victim",
          project: {
            workspace: { organizationId: "org-victim" },
          },
        }),
      },
    } as unknown as PrismaClient;

    const security = new TenantSecurityService(mockPrisma);

    const attackerTenant: TenantContext = {
      organizationId: "org-attacker",
      userId: "user-attacker",
      role: "ADMIN",
    };

    // 1. Cross-tenant workspace access
    await expect(security.assertWorkspaceAccess(attackerTenant, "ws-victim")).rejects.toThrow(
      TenantIsolationError,
    );

    // 2. Cross-tenant project access
    await expect(security.assertProjectAccess(attackerTenant, "proj-victim")).rejects.toThrow(
      TenantIsolationError,
    );

    // 3. Cross-tenant mission access
    await expect(security.assertMissionAccess(attackerTenant, "mission-victim")).rejects.toThrow(
      TenantIsolationError,
    );

    // 4. Same-tenant access should succeed
    const legitimateTenant: TenantContext = {
      organizationId: "org-victim",
      userId: "user-legit",
      role: "MEMBER",
    };

    await expect(security.assertWorkspaceAccess(legitimateTenant, "ws-victim")).resolves.toBeUndefined();
    await expect(security.assertProjectAccess(legitimateTenant, "proj-victim")).resolves.toBeUndefined();
    await expect(security.assertMissionAccess(legitimateTenant, "mission-victim")).resolves.toBeUndefined();
  });
});
