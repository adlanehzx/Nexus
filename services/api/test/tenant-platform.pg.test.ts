import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import { PrismaUserStore } from "../src/services/persistence/prisma-user-store.js";
import {
  TenantAccessDenied,
  TenantPlatformService,
  TenantRealtimeHub,
  VerifiedEnterpriseIdentityAdapter,
} from "../src/services/tenant-platform.js";
import { createAccount, makeApi } from "./harness.js";

const DATABASE_URL = process.env.DATABASE_URL;
let prisma: PrismaClient;
let service: TenantPlatformService;
let ownerA: string;
let ownerB: string;
let memberA: string;
let organizationA: string;
let organizationB: string;
const apiUserIds: string[] = [];
const apiOrganizationIds: string[] = [];

beforeAll(async () => {
  if (DATABASE_URL === undefined)
    throw new Error("DATABASE_URL is required for tenant PostgreSQL tests");
  prisma = createDatabaseClient({ url: DATABASE_URL });
  const users = new PrismaUserStore(prisma);
  const suffix = randomUUID();
  ownerA = (
    await users.create({
      email: `tenant-a-${suffix}@example.test`,
      displayName: "Tenant A owner",
      passwordHash: "scrypt$65536$8$1$aaaa$bbbb",
    })
  ).id;
  ownerB = (
    await users.create({
      email: `tenant-b-${suffix}@example.test`,
      displayName: "Tenant B owner",
      passwordHash: "scrypt$65536$8$1$aaaa$bbbb",
    })
  ).id;
  memberA = (
    await users.create({
      email: `tenant-member-${suffix}@example.test`,
      displayName: "Tenant A member",
      passwordHash: "scrypt$65536$8$1$aaaa$bbbb",
    })
  ).id;
  service = new TenantPlatformService(prisma);
  organizationA = (
    await service.createOrganization(ownerA, { name: "Organization A", slug: `org-a-${suffix}` })
  ).id;
  organizationB = (
    await service.createOrganization(ownerB, { name: "Organization B", slug: `org-b-${suffix}` })
  ).id;
});

afterAll(async () => {
  if (prisma === undefined) return;
  await prisma.organization.deleteMany({ where: { id: { in: [organizationA, organizationB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: apiOrganizationIds } } });
  const userIds = [ownerA, ownerB, memberA, ...apiUserIds];
  await prisma.authCredential.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("TenantPlatformService on PostgreSQL", () => {
  it("keeps personal mode provider-free and stable across repeated initialization", async () => {
    const first = await service.ensurePersonalOrganization(memberA);
    const second = await service.ensurePersonalOrganization(memberA);
    expect(first).toEqual(second);
    expect(first.mode).toBe("LOCAL");
    await prisma.organization.delete({ where: { id: first.id } });
  });

  it("enforces advanced roles, organization/team membership, and deny-by-default ACLs", async () => {
    await service.addMember(organizationA, ownerA, { userId: memberA, role: "TEAM_MANAGER" });
    const team = await service.createTeam(organizationA, memberA, "Security");
    await service.addTeamMember(organizationA, memberA, team.id, memberA);
    await service.shareMission(organizationA, ownerA, {
      missionId: "mission-a",
      principalType: "TEAM",
      principalId: team.id,
      permission: "VIEW",
    });
    expect(await service.canAccessMission(organizationA, memberA, "mission-a")).toBe(true);
    expect(await service.canAccessMission(organizationB, memberA, "mission-a")).toBe(false);
    await expect(service.getOrganization(organizationA, ownerB)).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
    await expect(
      service.addTeamMember(organizationB, ownerB, team.id, memberA),
    ).rejects.toBeDefined();
  });

  it("uses one verified identity port for OIDC and SAML without storing secrets", async () => {
    const oidc = await service.configureIdentity(organizationA, ownerA, {
      protocol: "OIDC",
      issuer: "https://identity.example.test/oidc",
      clientId: "nexus-oidc",
      metadata: { discovery: true },
      enabled: true,
    });
    const saml = await service.configureIdentity(organizationA, ownerA, {
      protocol: "SAML",
      issuer: "https://identity.example.test/saml",
      clientId: "nexus-saml",
      metadata: { entityId: "urn:nexus" },
      enabled: true,
    });
    const verifier = (response: string) =>
      Promise.resolve({
        subject: `subject:${response}`,
        email: "member@example.test",
      });
    const oidcAdapter = new VerifiedEnterpriseIdentityAdapter("OIDC", verifier);
    const samlAdapter = new VerifiedEnterpriseIdentityAdapter("SAML", verifier);
    expect(oidcAdapter.begin(oidc, "state", "https://nexus.example.test/callback")).toContain(
      "response_type=code",
    );
    expect(samlAdapter.begin(saml, "state", "https://nexus.example.test/callback")).toContain(
      "RelayState=state",
    );
    await expect(oidcAdapter.verify(oidc, "signed-response")).resolves.toMatchObject({
      subject: "subject:signed-response",
    });
    await expect(
      service.configureIdentity(organizationA, ownerA, {
        protocol: "OIDC",
        issuer: "https://identity.example.test/unsafe",
        clientId: "unsafe",
        metadata: { clientSecret: "must-not-be-stored" },
      }),
    ).rejects.toThrow("cannot contain secrets");
  });

  it("administers quota atomically and preserves absent quota as unknown", async () => {
    expect(await service.quota(organizationA, ownerA, "tokens")).toBeUndefined();
    await service.setQuota(organizationA, ownerA, "tokens", 5n);
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => service.consumeQuota(organizationA, "tokens", 1n)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(5);
    await expect(service.quota(organizationA, ownerB, "tokens")).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
  });

  it("isolates billing, fleet, collaboration, and artifact queries by organization", async () => {
    await service.recordUsage(organizationA, ownerA, {
      provider: "provider-a",
      metric: "tokens",
      quantity: 42n,
      costMicrounits: null,
      official: false,
      occurredAt: new Date("2026-10-24T12:00:00.000Z"),
    });
    await service.registerFleetInstallation(organizationA, ownerA, {
      installationId: "installation-a",
      displayName: "Paris",
      status: "ONLINE",
      capabilities: ["browser"],
      lastSeenAt: new Date("2026-10-24T12:00:00.000Z"),
    });
    const collaboration = await service.appendCollaborationEvent(organizationA, memberA, {
      channelId: "mission-a",
      kind: "cursor",
      payload: { line: 12 },
    });
    await service.registerArtifact(organizationA, ownerA, {
      missionId: "mission-a",
      artifactKey: "report",
      uri: "artifact://report",
      sha256: "a".repeat(64),
    });

    expect(await service.listUsage(organizationA, ownerA)).toHaveLength(1);
    expect(await service.listFleet(organizationA, memberA)).toEqual([
      { installationId: "installation-a", status: "ONLINE" },
    ]);
    expect(await service.collaborationEvents(organizationA, memberA, "mission-a")).toMatchObject([
      { sequence: collaboration.sequence, actorUserId: memberA },
    ]);
    expect(await service.listArtifacts(organizationA, memberA, "mission-a")).toHaveLength(1);

    await expect(service.listUsage(organizationA, ownerB)).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
    await expect(service.listFleet(organizationA, ownerB)).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
    await expect(
      service.collaborationEvents(organizationA, ownerB, "mission-a"),
    ).rejects.toBeInstanceOf(TenantAccessDenied);
    await expect(service.listArtifacts(organizationA, ownerB, "mission-a")).rejects.toBeInstanceOf(
      TenantAccessDenied,
    );
    expect(await service.listUsage(organizationB, ownerB)).toEqual([]);
    expect(await service.listFleet(organizationB, ownerB)).toEqual([]);
    expect(await service.collaborationEvents(organizationB, ownerB, "mission-a")).toEqual([]);
    expect(await service.listArtifacts(organizationB, ownerB, "mission-a")).toEqual([]);
  });

  it("broadcasts real-time collaboration only within the organization channel", () => {
    const hub = new TenantRealtimeHub();
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    const unsubscribeA = hub.subscribe(organizationA, "mission-a", (event) =>
      receivedA.push(event),
    );
    hub.subscribe(organizationB, "mission-a", (event) => receivedB.push(event));
    hub.publish(organizationA, "mission-a", { sequence: 1 });
    unsubscribeA();
    hub.publish(organizationA, "mission-a", { sequence: 2 });
    expect(receivedA).toEqual([{ sequence: 1 }]);
    expect(receivedB).toEqual([]);
  });

  it("denies cross-tenant access through every organization public route", async () => {
    const harness = await makeApi({ prisma });
    try {
      const suffix = randomUUID();
      const accountA = await createAccount(harness, `api-a-${suffix}@example.test`);
      const accountB = await createAccount(harness, `api-b-${suffix}@example.test`);
      apiUserIds.push(accountA.userId, accountB.userId);
      const create = await harness.app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: accountA.authorization,
        payload: { name: "API Organization A", slug: `api-a-${suffix}` },
      });
      expect(create.statusCode).toBe(201);
      const organizationId = create.json<{ data: { organization: { id: string } } }>().data
        .organization.id;
      apiOrganizationIds.push(organizationId);
      const randomId = randomUUID();
      const requests: {
        method: "GET" | "POST" | "PUT";
        url: string;
        payload?: Record<string, unknown>;
      }[] = [
        { method: "GET", url: `/api/v1/organizations/${organizationId}` },
        {
          method: "PUT",
          url: `/api/v1/organizations/${organizationId}/members/${accountB.userId}`,
          payload: { role: "MEMBER" },
        },
        {
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/teams`,
          payload: { name: "Denied" },
        },
        {
          method: "PUT",
          url: `/api/v1/organizations/${organizationId}/teams/${randomId}/members/${accountB.userId}`,
        },
        {
          method: "PUT",
          url: `/api/v1/organizations/${organizationId}/identity`,
          payload: {
            protocol: "OIDC",
            issuer: "https://identity.example.test",
            clientId: "denied",
          },
        },
        {
          method: "PUT",
          url: `/api/v1/organizations/${organizationId}/quotas/tokens`,
          payload: { limit: "1" },
        },
        { method: "GET", url: `/api/v1/organizations/${organizationId}/quotas/tokens` },
        {
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/mission-shares`,
          payload: {
            missionId: "mission-a",
            principalType: "USER",
            principalId: accountB.userId,
            permission: "VIEW",
          },
        },
        {
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/usage`,
          payload: {
            provider: "test",
            metric: "tokens",
            quantity: "1",
            costMicrounits: null,
            official: false,
            occurredAt: "2026-10-24T12:00:00.000Z",
          },
        },
        { method: "GET", url: `/api/v1/organizations/${organizationId}/usage` },
        {
          method: "PUT",
          url: `/api/v1/organizations/${organizationId}/fleet/remote-a`,
          payload: {
            displayName: "Denied",
            status: "ONLINE",
            capabilities: [],
            lastSeenAt: "2026-10-24T12:00:00.000Z",
          },
        },
        { method: "GET", url: `/api/v1/organizations/${organizationId}/fleet` },
        {
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/collaboration/mission-a/events`,
          payload: { kind: "cursor", payload: { line: 1 } },
        },
        {
          method: "GET",
          url: `/api/v1/organizations/${organizationId}/collaboration/mission-a/events`,
        },
        {
          method: "GET",
          url: `/api/v1/organizations/${organizationId}/collaboration/mission-a/stream`,
        },
        {
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/artifacts`,
          payload: {
            missionId: "mission-a",
            artifactKey: "report",
            uri: "artifact://report",
            sha256: "b".repeat(64),
          },
        },
        {
          method: "GET",
          url: `/api/v1/organizations/${organizationId}/artifacts?missionId=mission-a`,
        },
      ];
      for (const request of requests) {
        const response = await harness.app.inject({
          ...request,
          headers: accountB.authorization,
        });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
      }
    } finally {
      await harness.close();
    }
  });
});
