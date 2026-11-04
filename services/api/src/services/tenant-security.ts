/**
 * NEXUS Multi-Tenant Security & Isolation Service (LOT B)
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { uuidv7 } from "@nexus/shared";
import type { PrismaClient } from "@nexus/database";

export interface TenantContext {
  organizationId: string;
  workspaceId?: string;
  userId: string;
  role: "ADMIN" | "MEMBER" | "VIEWER";
}

export class TenantIsolationError extends Error {
  readonly code = "TENANT_ISOLATION_VIOLATION";
  readonly statusCode = 403;
  readonly tenantContext?: TenantContext | undefined;

  constructor(message: string, tenantContext?: TenantContext) {
    super(message);
    this.name = "TenantIsolationError";
    this.tenantContext = tenantContext;
  }
}

export class TenantSecurityService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Ensures an individual user has a default personal organization and default workspace.
   * This provides full backward compatibility with personal/local mode.
   */
  async ensurePersonalTenant(userId: string, email: string): Promise<{
    organizationId: string;
    workspaceId: string;
  }> {
    // Check if user already has an organization membership
    const membership = await this.prisma.organizationMembership.findFirst({
      where: { userId },
      include: { organization: { include: { workspaces: true } } },
    });

    if (membership?.organization) {
      const org = membership.organization;
      let defaultWorkspace = org.workspaces.find((w) => w.isDefault) ?? org.workspaces[0];

      if (!defaultWorkspace) {
        defaultWorkspace = await this.prisma.workspace.create({
          data: {
            id: uuidv7(),
            organizationId: org.id,
            slug: "default",
            name: "Default Workspace",
            isDefault: true,
          },
        });
      }

      return {
        organizationId: org.id,
        workspaceId: defaultWorkspace.id,
      };
    }

    // Create personal organization and default workspace
    const orgId = uuidv7();
    const slug = `personal-${userId.slice(0, 8)}`;
    const workspaceId = uuidv7();

    await this.prisma.organization.create({
      data: {
        id: orgId,
        slug,
        name: `Personal (${email.split("@")[0]})`,
        mode: "LOCAL",
        memberships: {
          create: {
            userId,
            role: "ADMIN",
          },
        },
        workspaces: {
          create: {
            id: workspaceId,
            slug: "default",
            name: "Personal Workspace",
            isDefault: true,
            memberships: {
              create: {
                userId,
                role: "ADMIN",
              },
            },
          },
        },
      },
    });

    return { organizationId: orgId, workspaceId };
  }

  /**
   * Asserts that a workspace belongs strictly to the tenant's organization.
   */
  async assertWorkspaceAccess(tenant: TenantContext, workspaceId: string): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });

    if (!ws || ws.organizationId !== tenant.organizationId) {
      throw new TenantIsolationError("Access denied to requested workspace", tenant);
    }
  }

  /**
   * Asserts that a project belongs strictly to the tenant's organization through its workspace.
   */
  async assertProjectAccess(tenant: TenantContext, projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { workspace: { select: { organizationId: true } } },
    });

    if (!project || project.workspace.organizationId !== tenant.organizationId) {
      throw new TenantIsolationError("Access denied to requested project", tenant);
    }
  }

  /**
   * Asserts that a mission belongs to the caller's organization.
   */
  async assertMissionAccess(tenant: TenantContext, missionId: string): Promise<void> {
    const mission = await this.prisma.tenantMission.findUnique({
      where: { id: missionId },
      include: { project: { include: { workspace: { select: { organizationId: true } } } } },
    });

    if (!mission || mission.project.workspace.organizationId !== tenant.organizationId) {
      throw new TenantIsolationError("Access denied to requested mission", tenant);
    }
  }
}
