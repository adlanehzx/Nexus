import { createHash } from "node:crypto";
import { z } from "zod";
import type { InputJsonObject, PrismaClient } from "@nexus/database";
import { AppError, uuidv7, type ErrorSeverity } from "@nexus/shared";

export const organizationRoleSchema = z.enum([
  "OWNER",
  "ORG_ADMIN",
  "TEAM_MANAGER",
  "MEMBER",
  "AUDITOR",
  "BILLING_ADMIN",
]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const identityProtocolSchema = z.enum(["OIDC", "SAML"]);
export type IdentityProtocol = z.infer<typeof identityProtocolSchema>;

type OrganizationPermission =
  | "organization.read"
  | "organization.manage_members"
  | "organization.manage_teams"
  | "organization.manage_identity"
  | "organization.manage_quota"
  | "organization.view_billing"
  | "organization.record_billing"
  | "mission.share"
  | "mission.read"
  | "artifact.write"
  | "artifact.read"
  | "collaboration.write"
  | "collaboration.read"
  | "fleet.manage"
  | "fleet.read";

const ALL_PERMISSIONS: readonly OrganizationPermission[] = [
  "organization.read",
  "organization.manage_members",
  "organization.manage_teams",
  "organization.manage_identity",
  "organization.manage_quota",
  "organization.view_billing",
  "organization.record_billing",
  "mission.share",
  "mission.read",
  "artifact.write",
  "artifact.read",
  "collaboration.write",
  "collaboration.read",
  "fleet.manage",
  "fleet.read",
];

const ROLE_PERMISSIONS: Record<OrganizationRole, readonly OrganizationPermission[]> = {
  OWNER: ALL_PERMISSIONS,
  ORG_ADMIN: ALL_PERMISSIONS.filter((permission) => permission !== "organization.record_billing"),
  TEAM_MANAGER: [
    "organization.read",
    "organization.manage_teams",
    "mission.share",
    "mission.read",
    "artifact.write",
    "artifact.read",
    "collaboration.write",
    "collaboration.read",
    "fleet.read",
  ],
  MEMBER: [
    "organization.read",
    "mission.read",
    "artifact.read",
    "collaboration.write",
    "collaboration.read",
    "fleet.read",
  ],
  AUDITOR: [
    "organization.read",
    "mission.read",
    "artifact.read",
    "collaboration.read",
    "fleet.read",
    "organization.view_billing",
  ],
  BILLING_ADMIN: [
    "organization.read",
    "organization.manage_quota",
    "organization.view_billing",
    "organization.record_billing",
  ],
};

export class TenantAccessDenied extends AppError {
  readonly code = "TENANT_RESOURCE_NOT_FOUND";
  readonly httpStatus = 404;
  override readonly severity: ErrorSeverity = "warning";

  constructor() {
    super({
      message: "Organization resource not found or access denied",
      userMessage: "The requested organization resource does not exist.",
    });
    this.name = "TenantAccessDenied";
  }
}

export class TenantConflict extends AppError {
  readonly code = "TENANT_CONFLICT";
  readonly httpStatus = 409;
  override readonly severity: ErrorSeverity = "warning";

  constructor(message: string) {
    super({ message, userMessage: message });
    this.name = "TenantConflict";
  }
}

export interface TenantOrganization {
  id: string;
  slug: string;
  name: string;
  mode: "LOCAL" | "HOSTED";
}

export interface FederatedIdentityConnection {
  id: string;
  organizationId: string;
  protocol: IdentityProtocol;
  issuer: string;
  clientId: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
}

export interface EnterpriseIdentityPort {
  readonly protocol: IdentityProtocol;
  begin(connection: FederatedIdentityConnection, state: string, redirectUri: string): string;
  verify(
    connection: FederatedIdentityConnection,
    response: string,
  ): Promise<{ subject: string; email: string }>;
}

/** One identity contract for OIDC and SAML; signature verification is injected and mandatory. */
export class VerifiedEnterpriseIdentityAdapter implements EnterpriseIdentityPort {
  readonly protocol: IdentityProtocol;
  readonly #verifyResponse: (
    response: string,
    connection: FederatedIdentityConnection,
  ) => Promise<{ subject: string; email: string }>;

  constructor(
    protocol: IdentityProtocol,
    verifyResponse: (
      response: string,
      connection: FederatedIdentityConnection,
    ) => Promise<{ subject: string; email: string }>,
  ) {
    this.protocol = protocol;
    this.#verifyResponse = verifyResponse;
  }

  begin(connection: FederatedIdentityConnection, state: string, redirectUri: string): string {
    if (connection.protocol !== this.protocol || !connection.enabled) {
      throw new TenantAccessDenied();
    }
    const issuer = new URL(connection.issuer);
    if (issuer.protocol !== "https:") throw new TenantConflict("Identity issuer must use HTTPS");
    if (this.protocol === "OIDC") {
      const issuerUrl = issuer.toString();
      const url = new URL("authorize", issuerUrl.endsWith("/") ? issuerUrl : `${issuerUrl}/`);
      url.searchParams.set("client_id", connection.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("state", state);
      return url.toString();
    }
    const issuerUrl = issuer.toString();
    const url = new URL("sso", issuerUrl.endsWith("/") ? issuerUrl : `${issuerUrl}/`);
    url.searchParams.set("RelayState", state);
    url.searchParams.set("AssertionConsumerServiceURL", redirectUri);
    return url.toString();
  }

  async verify(
    connection: FederatedIdentityConnection,
    response: string,
  ): Promise<{ subject: string; email: string }> {
    if (connection.protocol !== this.protocol || !connection.enabled || response.length === 0) {
      throw new TenantAccessDenied();
    }
    return this.#verifyResponse(response, connection);
  }
}

export interface BillingUsageInput {
  provider: string;
  metric: string;
  quantity: bigint;
  costMicrounits: bigint | null;
  official: boolean;
  occurredAt: Date;
}

export class TenantPlatformService {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async createOrganization(
    ownerUserId: string,
    input: { name: string; slug: string; mode?: "LOCAL" | "HOSTED" },
  ): Promise<TenantOrganization> {
    const slug = normalizeSlug(input.slug);
    const organization = await this.#prisma.organization.create({
      data: {
        id: uuidv7(),
        name: input.name.trim(),
        slug,
        mode: input.mode ?? "HOSTED",
        memberships: { create: { userId: ownerUserId, role: "OWNER" } },
      },
    });
    return presentOrganization(organization);
  }

  async ensurePersonalOrganization(userId: string): Promise<TenantOrganization> {
    const slug = `personal-${createHash("sha256").update(userId).digest("hex").slice(0, 20)}`;
    return this.#prisma.$transaction(async (tx) => {
      const existing = await tx.organization.findUnique({ where: { slug } });
      if (existing !== null) return presentOrganization(existing);
      const organization = await tx.organization.create({
        data: { id: uuidv7(), slug, name: "Personal", mode: "LOCAL" },
      });
      await tx.organizationMembership.create({
        data: { organizationId: organization.id, userId, role: "OWNER" },
      });
      return presentOrganization(organization);
    });
  }

  async getOrganization(organizationId: string, actorUserId: string): Promise<TenantOrganization> {
    await this.#authorize(organizationId, actorUserId, "organization.read");
    const row = await this.#prisma.organization.findUnique({ where: { id: organizationId } });
    if (row === null) throw new TenantAccessDenied();
    return presentOrganization(row);
  }

  async addMember(
    organizationId: string,
    actorUserId: string,
    input: { userId: string; role: OrganizationRole },
  ): Promise<void> {
    await this.#authorize(organizationId, actorUserId, "organization.manage_members");
    const role = organizationRoleSchema.parse(input.role);
    await this.#prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId, userId: input.userId } },
      create: { organizationId, userId: input.userId, role },
      update: { role },
    });
  }

  async createTeam(
    organizationId: string,
    actorUserId: string,
    name: string,
  ): Promise<{ id: string; name: string }> {
    await this.#authorize(organizationId, actorUserId, "organization.manage_teams");
    const row = await this.#prisma.team.create({
      data: { id: uuidv7(), organizationId, name: name.trim() },
    });
    return { id: row.id, name: row.name };
  }

  async addTeamMember(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    userId: string,
  ): Promise<void> {
    await this.#authorize(organizationId, actorUserId, "organization.manage_teams");
    const member = await this.#prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (member === null) throw new TenantAccessDenied();
    await this.#prisma.teamMembership.create({ data: { organizationId, teamId, userId } });
  }

  async configureIdentity(
    organizationId: string,
    actorUserId: string,
    input: {
      protocol: IdentityProtocol;
      issuer: string;
      clientId: string;
      metadata?: Record<string, unknown> | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<FederatedIdentityConnection> {
    await this.#authorize(organizationId, actorUserId, "organization.manage_identity");
    const protocol = identityProtocolSchema.parse(input.protocol);
    const issuer = new URL(input.issuer);
    if (issuer.protocol !== "https:") throw new TenantConflict("Identity issuer must use HTTPS");
    rejectSecretFields(input.metadata ?? {});
    const metadata = toJsonObject(input.metadata ?? {});
    const row = await this.#prisma.organizationIdentityProvider.upsert({
      where: {
        organizationId_protocol_issuer: {
          organizationId,
          protocol,
          issuer: issuer.toString(),
        },
      },
      create: {
        id: uuidv7(),
        organizationId,
        protocol,
        issuer: issuer.toString(),
        clientId: input.clientId,
        metadata,
        enabled: input.enabled ?? false,
      },
      update: {
        clientId: input.clientId,
        metadata,
        enabled: input.enabled ?? false,
      },
    });
    return presentIdentity(row);
  }

  async setQuota(
    organizationId: string,
    actorUserId: string,
    key: string,
    limit: bigint,
  ): Promise<void> {
    await this.#authorize(organizationId, actorUserId, "organization.manage_quota");
    if (limit < 0n) throw new TenantConflict("Quota cannot be negative");
    await this.#prisma.organizationQuota.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, limit, used: 0n },
      update: { limit },
    });
  }

  async consumeQuota(organizationId: string, key: string, quantity: bigint): Promise<boolean> {
    if (quantity <= 0n) throw new TenantConflict("Quota consumption must be positive");
    const rows = await this.#prisma.$queryRaw<[{ used: bigint }] | []>`
      UPDATE organization_quotas
      SET used = used + ${quantity}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "organizationId" = ${organizationId}::uuid
        AND key = ${key}
        AND used + ${quantity} <= "limit"
      RETURNING used
    `;
    return rows.length === 1;
  }

  async quota(
    organizationId: string,
    actorUserId: string,
    key: string,
  ): Promise<{ limit: bigint; used: bigint } | undefined> {
    await this.#authorize(organizationId, actorUserId, "organization.read");
    const row = await this.#prisma.organizationQuota.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });
    return row === null ? undefined : { limit: row.limit, used: row.used };
  }

  async shareMission(
    organizationId: string,
    actorUserId: string,
    input: {
      missionId: string;
      principalType: "USER" | "TEAM";
      principalId: string;
      permission: "VIEW" | "COMMENT" | "EDIT";
    },
  ): Promise<string> {
    await this.#authorize(organizationId, actorUserId, "mission.share");
    await this.#validatePrincipal(organizationId, input.principalType, input.principalId);
    const row = await this.#prisma.missionAccessGrant.create({
      data: {
        id: uuidv7(),
        organizationId,
        missionId: input.missionId,
        principalType: input.principalType,
        principalId: input.principalId,
        permission: input.permission,
        createdBy: actorUserId,
      },
    });
    return row.id;
  }

  async canAccessMission(
    organizationId: string,
    userId: string,
    missionId: string,
  ): Promise<boolean> {
    const membership = await this.#membership(organizationId, userId);
    if (membership === null) return false;
    if (["OWNER", "ORG_ADMIN"].includes(membership.role)) return true;
    const direct = await this.#prisma.missionAccessGrant.findFirst({
      where: { organizationId, missionId, principalType: "USER", principalId: userId },
    });
    if (direct !== null) return true;
    const teams = await this.#prisma.teamMembership.findMany({
      where: { organizationId, userId },
      select: { teamId: true },
    });
    return (
      (await this.#prisma.missionAccessGrant.count({
        where: {
          organizationId,
          missionId,
          principalType: "TEAM",
          principalId: { in: teams.map((team) => team.teamId) },
        },
      })) > 0
    );
  }

  async recordUsage(
    organizationId: string,
    actorUserId: string,
    input: BillingUsageInput,
  ): Promise<string> {
    await this.#authorize(organizationId, actorUserId, "organization.record_billing");
    if (input.quantity < 0n || (input.costMicrounits !== null && input.costMicrounits < 0n)) {
      throw new TenantConflict("Usage values cannot be negative");
    }
    const row = await this.#prisma.billingUsageRecord.create({
      data: { id: uuidv7(), organizationId, ...input },
    });
    return row.id;
  }

  async listUsage(organizationId: string, actorUserId: string): Promise<BillingUsageInput[]> {
    await this.#authorize(organizationId, actorUserId, "organization.view_billing");
    return this.#prisma.billingUsageRecord.findMany({
      where: { organizationId },
      orderBy: { occurredAt: "asc" },
      select: {
        provider: true,
        metric: true,
        quantity: true,
        costMicrounits: true,
        official: true,
        occurredAt: true,
      },
    });
  }

  async registerFleetInstallation(
    organizationId: string,
    actorUserId: string,
    input: {
      installationId: string;
      displayName: string;
      status: "ONLINE" | "OFFLINE" | "DEGRADED";
      capabilities: string[];
      lastSeenAt: Date;
    },
  ): Promise<string> {
    await this.#authorize(organizationId, actorUserId, "fleet.manage");
    const row = await this.#prisma.fleetInstallation.upsert({
      where: {
        organizationId_installationId: {
          organizationId,
          installationId: input.installationId,
        },
      },
      create: { id: uuidv7(), organizationId, ...input },
      update: input,
    });
    return row.id;
  }

  async listFleet(
    organizationId: string,
    actorUserId: string,
  ): Promise<{ installationId: string; status: string }[]> {
    await this.#authorize(organizationId, actorUserId, "fleet.read");
    return this.#prisma.fleetInstallation.findMany({
      where: { organizationId },
      orderBy: { installationId: "asc" },
      select: { installationId: true, status: true },
    });
  }

  async appendCollaborationEvent(
    organizationId: string,
    actorUserId: string,
    input: { channelId: string; kind: string; payload: Record<string, unknown> },
  ): Promise<{ id: string; sequence: number }> {
    await this.#authorize(organizationId, actorUserId, "collaboration.write");
    return this.#prisma.$transaction(
      async (tx) => {
        const latest = await tx.organizationCollaborationEvent.findFirst({
          where: { organizationId, channelId: input.channelId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        const row = await tx.organizationCollaborationEvent.create({
          data: {
            id: uuidv7(),
            organizationId,
            channelId: input.channelId,
            actorUserId,
            sequence: (latest?.sequence ?? 0) + 1,
            kind: input.kind,
            payload: toJsonObject(input.payload),
          },
        });
        return { id: row.id, sequence: row.sequence };
      },
      { isolationLevel: "Serializable" },
    );
  }

  async collaborationEvents(
    organizationId: string,
    actorUserId: string,
    channelId: string,
    afterSequence = 0,
  ): Promise<{ sequence: number; actorUserId: string; kind: string; payload: unknown }[]> {
    await this.#authorize(organizationId, actorUserId, "collaboration.read");
    return this.#prisma.organizationCollaborationEvent.findMany({
      where: { organizationId, channelId, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      select: { sequence: true, actorUserId: true, kind: true, payload: true },
    });
  }

  async registerArtifact(
    organizationId: string,
    actorUserId: string,
    input: { missionId: string; artifactKey: string; uri: string; sha256: string },
  ): Promise<string> {
    await this.#authorize(organizationId, actorUserId, "artifact.write");
    const row = await this.#prisma.organizationArtifact.create({
      data: { id: uuidv7(), organizationId, createdBy: actorUserId, ...input },
    });
    return row.id;
  }

  async listArtifacts(
    organizationId: string,
    actorUserId: string,
    missionId: string,
  ): Promise<{ artifactKey: string; uri: string; sha256: string }[]> {
    await this.#authorize(organizationId, actorUserId, "artifact.read");
    if (!(await this.canAccessMission(organizationId, actorUserId, missionId))) return [];
    return this.#prisma.organizationArtifact.findMany({
      where: { organizationId, missionId },
      orderBy: { artifactKey: "asc" },
      select: { artifactKey: true, uri: true, sha256: true },
    });
  }

  async #authorize(
    organizationId: string,
    userId: string,
    permission: OrganizationPermission,
  ): Promise<void> {
    const membership = await this.#membership(organizationId, userId);
    const parsed = organizationRoleSchema.safeParse(membership?.role);
    if (!parsed.success || !ROLE_PERMISSIONS[parsed.data].includes(permission)) {
      throw new TenantAccessDenied();
    }
  }

  #membership(organizationId: string, userId: string) {
    return this.#prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  }

  async #validatePrincipal(
    organizationId: string,
    principalType: "USER" | "TEAM",
    principalId: string,
  ): Promise<void> {
    const exists =
      principalType === "USER"
        ? await this.#prisma.organizationMembership.findUnique({
            where: { organizationId_userId: { organizationId, userId: principalId } },
          })
        : await this.#prisma.team.findUnique({
            where: { organizationId_id: { organizationId, id: principalId } },
          });
    if (exists === null) throw new TenantAccessDenied();
  }
}

export class TenantRealtimeHub {
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  subscribe(
    organizationId: string,
    channelId: string,
    listener: (event: unknown) => void,
  ): () => void {
    const key = `${organizationId}:${channelId}`;
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  publish(organizationId: string, channelId: string, event: unknown): void {
    for (const listener of this.#listeners.get(`${organizationId}:${channelId}`) ?? [])
      listener(event);
  }
}

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug))
    throw new TenantConflict("Invalid organization slug");
  return slug;
}

function presentOrganization(input: {
  id: string;
  slug: string;
  name: string;
  mode: string;
}): TenantOrganization {
  return {
    id: input.id,
    slug: input.slug,
    name: input.name,
    mode: input.mode === "LOCAL" ? "LOCAL" : "HOSTED",
  };
}

function presentIdentity(input: {
  id: string;
  organizationId: string;
  protocol: string;
  issuer: string;
  clientId: string;
  metadata: unknown;
  enabled: boolean;
}): FederatedIdentityConnection {
  return {
    id: input.id,
    organizationId: input.organizationId,
    protocol: identityProtocolSchema.parse(input.protocol),
    issuer: input.issuer,
    clientId: input.clientId,
    metadata: z.record(z.string(), z.unknown()).parse(input.metadata),
    enabled: input.enabled,
  };
}

function rejectSecretFields(input: unknown): void {
  if (Array.isArray(input)) {
    for (const value of input) rejectSecretFields(value);
    return;
  }
  if (input === null || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input)) {
    if (/secret|token|password|private|assertion/i.test(key)) {
      throw new TenantConflict("Identity metadata cannot contain secrets");
    }
    rejectSecretFields(value);
  }
}

function toJsonObject(input: Record<string, unknown>): InputJsonObject {
  return JSON.parse(JSON.stringify(input)) as InputJsonObject;
}
