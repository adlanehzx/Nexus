import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import type { TaskPlan } from "@nexus/devices";
import { PrismaTaskStore } from "../src/services/persistence/prisma-task-store.js";
import { PrismaAgentRunStore } from "../src/services/persistence/prisma-agent-run-store.js";
import { PrismaUserStore } from "../src/services/persistence/prisma-user-store.js";
import { PrismaDeviceStore } from "../src/services/persistence/prisma-device-store.js";
import { PrismaAgentRunClaimStore } from "../src/services/persistence/prisma-agent-run-claim-store.js";
import { PrismaMissionGrantRegistry } from "../src/services/persistence/prisma-mission-grant-registry.js";
import { PrismaScheduleGrantRegistry } from "../src/services/persistence/prisma-schedule-grant-registry.js";

/**
 * Magasins Prisma contre un PostgreSQL réel.
 *
 * Ces tests existent parce que les doublures en mémoire ont laissé passer un
 * défaut de production entier : `PrismaTaskStore` écrivait des statuts en
 * minuscules dans un enum PostgreSQL qui n'admet que les majuscules. Aucun test
 * ne pouvait le voir, et les tables sont restées vides pendant des semaines
 * sans que rien ne le signale.
 *
 * La leçon dirige la conception de ce fichier : **ce qui n'est vérifié que
 * contre une doublure n'est pas vérifié.** On écrit donc vraiment, on relit
 * vraiment, et on va jusqu'à provoquer les refus de la base — contraintes
 * d'unicité, clés étrangères, valeurs d'enum.
 *
 * **Isolation.** Chaque exécution travaille sous des identifiants qui lui sont
 * propres et ne supprime que ses propres lignes, en remontant les dépendances.
 * Rien n'est tronqué : cette base peut être celle d'un poste de développement.
 */

const DATABASE_URL = process.env.DATABASE_URL;

/** Identifiants de cette exécution. Aucun autre test ne les touche. */
const deviceId = randomUUID();
const planId = randomUUID();
const stepId = randomUUID();
const executionId = randomUUID();
const runId = randomUUID();
const email = `pg-${randomUUID()}@exemple.test`;

/** Renseigné par le magasin, qui génère lui-même l'identifiant du compte. */
let ownerId: string;
let prisma: PrismaClient;

beforeAll(async () => {
  if (DATABASE_URL === undefined) {
    throw new Error(
      "DATABASE_URL est requis : ces tests écrivent dans un PostgreSQL réel. " +
        "Voir pnpm test:pg.",
    );
  }
  prisma = createDatabaseClient({ url: DATABASE_URL });

  // Le propriétaire et l'appareil d'origine ne sont pas du décor : `task_plans`
  // a une clé étrangère vers `devices`, qui en a une vers `users`. Les créer
  // par les magasins plutôt qu'en SQL éprouve aussi ces magasins-là.
  const owner = await new PrismaUserStore(prisma).create({
    email,
    displayName: "Intégration PostgreSQL",
    passwordHash: "scrypt$65536$8$1$aaaa$bbbb",
  });
  ownerId = owner.id;

  await new PrismaDeviceStore(prisma).save({
    id: deviceId,
    userId: ownerId,
    name: "Poste de test",
    type: "LINUX",
    platform: "LINUX",
    role: "WORKER",
    status: "ONLINE",
    trust: "TRUSTED",
    agentVersion: "1.0.0",
    health: { activeTasks: 0, maxConcurrentTasks: 1 },
    grantedPermissions: [],
    metadata: {},
    capabilities: [
      {
        name: "shell.exec",
        version: "1.0.0",
        description: "Exécute une commande",
        enabled: true,
        metadata: {},
      },
    ],
    lastSeenAt: null,
    pairedAt: new Date(),
    revokedAt: null,
    authenticated: false,
  });
});

afterAll(async () => {
  if (prisma === undefined) return;
  // Suppression ciblée, dans l'ordre des dépendances. Les cascades feraient
  // l'essentiel, mais les nommer documente ce que ce test a touché — et évite
  // de compter sur une cascade qu'une migration pourrait retirer.
  await prisma.taskExecution.deleteMany({ where: { taskId: planId } });
  await prisma.taskStep.deleteMany({ where: { taskId: planId } });
  await prisma.taskPlan.deleteMany({ where: { id: planId } });
  await prisma.agentCoreRunClaim.deleteMany({ where: { userId: ownerId } });
  await prisma.missionGrant.deleteMany({ where: { userId: ownerId } });
  await prisma.scheduleGrant.deleteMany({ where: { userId: ownerId } });
  await prisma.agentRunSnapshot.deleteMany({ where: { userId: ownerId } });
  await prisma.deviceCapability.deleteMany({ where: { deviceId } });
  await prisma.device.deleteMany({ where: { id: deviceId } });
  await prisma.authCredential.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: planId,
    userId: ownerId,
    title: "Mettre à jour le dépôt",
    originClientDeviceId: deviceId,
    runId: null,
    conversationId: null,
    correlationId: `corr-${planId}`,
    status: "pending",
    createdAt: new Date("2026-10-20T09:00:00.000Z").toISOString(),
    startedAt: null,
    completedAt: null,
    metadata: { source: "integration" },
    steps: [
      {
        id: stepId,
        description: "Cloner le dépôt",
        requiredCapabilities: ["shell.exec"],
        tool: "shell.exec",
        arguments: { cmd: "git clone" },
        dependsOn: [],
        selectedDeviceId: null,
        preferredDeviceId: null,
        riskLevel: "MEDIUM",
        retry: { attempts: 2, backoffMs: 500, failoverToAnotherDevice: true },
        timeoutMs: 10_000,
        status: "pending",
        attempt: 0,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

describe("magasin de tâches sur PostgreSQL", () => {
  it("écrit un plan que la base accepte, et le relit à l'identique", async () => {
    const store = new PrismaTaskStore(prisma);
    const original = plan();

    // C'est l'écriture qui échouait avant : PostgreSQL refusait `'pending'` sur
    // un enum qui n'admet que `PENDING`.
    await store.save(original);
    const reread = await store.get(planId);

    expect(reread).toBeDefined();
    expect(reread?.status).toBe("pending");
    expect(reread?.metadata).toEqual({ source: "integration" });
    expect(reread?.steps).toHaveLength(1);
    const step = reread?.steps[0];
    expect(step?.status).toBe("pending");
    // Le champ ne porte pas le même nom des deux côtés : la relecture doit
    // rendre `retry`, et jamais `retryPolicy`.
    expect(step?.retry).toEqual({ attempts: 2, backoffMs: 500, failoverToAnotherDevice: true });
    expect(step).not.toHaveProperty("retryPolicy");
    // Les dates du domaine sont des chaînes ISO : une `Date` ici signifierait
    // que la conversion a été court-circuitée.
    expect(typeof reread?.createdAt).toBe("string");
  });

  it("stocke réellement les statuts dans la casse de l'enum", async () => {
    const store = new PrismaTaskStore(prisma);
    await store.save(plan({ status: "running" }));

    // Lu en SQL brut, hors de toute correspondance : c'est le seul moyen de
    // prouver ce qui est vraiment dans la colonne.
    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM task_plans WHERE id = $1`,
      planId,
    );
    expect(rows[0]?.status).toBe("RUNNING");
  });

  it("fait progresser l'état d'une tâche et de son étape", async () => {
    const store = new PrismaTaskStore(prisma);
    const advanced = plan({
      status: "succeeded",
      startedAt: new Date("2026-10-20T09:01:00.000Z").toISOString(),
      completedAt: new Date("2026-10-20T09:02:00.000Z").toISOString(),
    });
    advanced.steps[0] = {
      ...advanced.steps[0]!,
      status: "succeeded",
      attempt: 1,
      selectedDeviceId: deviceId,
      result: { ok: true },
      startedAt: new Date("2026-10-20T09:01:00.000Z").toISOString(),
      completedAt: new Date("2026-10-20T09:02:00.000Z").toISOString(),
    };

    await store.save(advanced);
    const reread = await store.get(planId);

    expect(reread?.status).toBe("succeeded");
    expect(reread?.completedAt).toBe("2026-10-20T09:02:00.000Z");
    expect(reread?.steps[0]?.status).toBe("succeeded");
    expect(reread?.steps[0]?.attempt).toBe(1);
    expect(reread?.steps[0]?.selectedDeviceId).toBe(deviceId);
    expect(reread?.steps[0]?.result).toEqual({ ok: true });
  });

  it("écrit et relit une exécution", async () => {
    const store = new PrismaTaskStore(prisma);
    await store.saveExecution({
      id: executionId,
      taskId: planId,
      stepId,
      deviceId,
      attempt: 1,
      status: "failed",
      startedAt: new Date("2026-10-20T09:01:00.000Z").toISOString(),
      completedAt: new Date("2026-10-20T09:01:30.000Z").toISOString(),
      durationMs: 30_000,
      input: { cmd: "git clone" },
      result: null,
      error: { code: "E_SHELL", message: "exit 1", retryable: true },
    });

    const executions = await store.listExecutions(planId);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("failed");
    expect(executions[0]?.error).toEqual({
      code: "E_SHELL",
      message: "exit 1",
      retryable: true,
    });
    expect(executions[0]?.durationMs).toBe(30_000);
  });

  it("retrouve la tâche par utilisateur et par état actif", async () => {
    const store = new PrismaTaskStore(prisma);
    await store.save(plan({ status: "running" }));

    const mine = await store.listByUser(ownerId, 10);
    expect(mine.map((item) => item.id)).toContain(planId);

    const active = await store.listActive();
    expect(active.map((item) => item.id)).toContain(planId);

    // `listActive` filtre sur l'enum : un plan terminé doit en sortir, ce qui
    // vérifie au passage que le filtre est écrit dans la bonne casse.
    await store.save(plan({ status: "succeeded" }));
    const stillActive = await store.listActive();
    expect(stillActive.map((item) => item.id)).not.toContain(planId);
  });

  it("laisse la base refuser un statut hors de l'enum", async () => {
    // Le garde-fou de dernier recours : si la correspondance régressait, c'est
    // cette erreur qu'on veut voir, et il faut savoir qu'elle est bien levée.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE task_plans SET status = 'succeeded' WHERE id = $1`, planId),
    ).rejects.toThrow();
  });

  it("laisse la base refuser une tâche sans appareil d'origine", async () => {
    const store = new PrismaTaskStore(prisma);
    const orphan = plan({ id: randomUUID(), originClientDeviceId: randomUUID() });
    await expect(store.save(orphan)).rejects.toThrow();
  });
});

describe("magasin de runs Agent Core sur PostgreSQL", () => {
  it("persiste un run et sa mission, puis le relit", async () => {
    const store = new PrismaAgentRunStore(prisma);
    const state = {
      record: {
        runId,
        userId: ownerId,
        conversationId: randomUUID(),
        correlationId: `corr-${runId}`,
        startTime: new Date("2026-10-20T09:00:00.000Z").toISOString(),
        endTime: null,
        status: "waiting_for_confirmation" as const,
        stopReason: null,
        iterations: 1,
        toolsUsed: [],
        errors: [],
        usage: { inputTokens: 10, outputTokens: 20 },
        model: "test",
        response: null,
        missionExternalKey: "nexus-integration-mission",
      },
      messages: [],
      pendingConfirmation: null,
      consecutiveToolFailures: 0,
      toolCallCount: 0,
      callSignatures: [],
      deadlineAt: 0,
      suspendedAt: null,
    };

    await store.save(state);
    const loaded = await store.load(runId);

    expect(loaded?.record.status).toBe("waiting_for_confirmation");
    expect(loaded?.record.missionExternalKey).toBe("nexus-integration-mission");

    // La mission est aussi une colonne, pas seulement un champ de l'état
    // sérialisé : c'est elle qui porte la vérification de portée d'une
    // assertion, donc elle doit être interrogeable.
    const rows = await prisma.$queryRawUnsafe<{ key: string | null }[]>(
      `SELECT "missionExternalKey" AS key FROM agent_run_snapshots WHERE id = $1`,
      runId,
    );
    expect(rows[0]?.key).toBe("nexus-integration-mission");
  });

  it("met à jour un run existant sans en créer un second", async () => {
    const store = new PrismaAgentRunStore(prisma);
    const loaded = await store.require(runId);
    loaded.record.status = "completed";
    loaded.record.response = "fait";

    await store.save(loaded);

    const reread = await store.require(runId);
    expect(reread.record.status).toBe("completed");
    expect(reread.record.response).toBe("fait");
    const count = await prisma.agentRunSnapshot.count({ where: { userId: ownerId } });
    expect(count).toBe(1);
  });

  it("laisse la base refuser un run sans propriétaire", async () => {
    const store = new PrismaAgentRunStore(prisma);
    const orphan = await store.require(runId);
    orphan.record.runId = randomUUID();
    orphan.record.userId = randomUUID();

    await expect(store.save(orphan)).rejects.toThrow();
  });
});

describe("réservations de run Agent Core sur PostgreSQL", () => {
  const mission = "nexus-unicite-mission";

  it("accorde la réservation une seule fois, et rend l'existante ensuite", async () => {
    const store = new PrismaAgentRunClaimStore(prisma);
    const key = { missionExternalKey: mission, taskKey: "tache", attemptId: "attempt-1" };
    const first = randomUUID();

    expect(await store.claim({ ...key, runId: first, userId: ownerId })).toEqual({
      claimed: true,
    });

    const second = await store.claim({ ...key, runId: randomUUID(), userId: ownerId });
    expect(second.claimed).toBe(false);
    // C'est le run du premier appelant qui est rendu : celui du second est
    // simplement abandonné, et n'a jamais servi à lancer quoi que ce soit.
    expect(second.claimed === false && second.existing.runId).toBe(first);
  });

  it("tranche en faveur d'un seul appelant sous concurrence réelle", async () => {
    const store = new PrismaAgentRunClaimStore(prisma);
    const key = { missionExternalKey: mission, taskKey: "concurrente", attemptId: "attempt-1" };

    // Huit requêtes lancées ensemble. C'est le cas que le code existe pour
    // tenir, et celui qu'un `SELECT` suivi d'un `INSERT` perdrait : l'unicité
    // vient de l'index, pas d'une lecture préalable.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim({ ...key, runId: randomUUID(), userId: ownerId }),
      ),
    );

    expect(results.filter((item) => item.claimed)).toHaveLength(1);
    const winner = await store.find(key);
    const granted = results.find((item) => item.claimed === false);
    expect(granted?.claimed === false && granted.existing.runId).toBe(winner?.runId);
  });

  it("sépare les réservations par tâche, par tentative et par mission", async () => {
    const store = new PrismaAgentRunClaimStore(prisma);
    const base = { userId: ownerId, runId: randomUUID() };

    for (const key of [
      { missionExternalKey: mission, taskKey: "a", attemptId: "attempt-1" },
      { missionExternalKey: mission, taskKey: "b", attemptId: "attempt-1" },
      { missionExternalKey: mission, taskKey: "a", attemptId: "attempt-2" },
      { missionExternalKey: `${mission}-bis`, taskKey: "a", attemptId: "attempt-1" },
    ]) {
      expect(await store.claim({ ...base, ...key, runId: randomUUID() })).toEqual({
        claimed: true,
      });
    }
  });

  it("laisse la base refuser un doublon inséré hors du magasin", async () => {
    // Le garde-fou : si la contrainte disparaissait d'une migration, c'est ce
    // test qui le dirait, et non un comportement étrange en production.
    const duplicate = prisma.agentCoreRunClaim.create({
      data: {
        id: randomUUID(),
        missionExternalKey: mission,
        taskKey: "concurrente",
        attemptId: "attempt-1",
        runId: randomUUID(),
        userId: ownerId,
      },
    });
    await expect(duplicate).rejects.toThrow();
  });
});

describe("registre des assertions sur PostgreSQL", () => {
  const mission = "nexus-registre-mission";

  it("inscrit, relit et retire", async () => {
    const registry = new PrismaMissionGrantRegistry(prisma);
    const grantId = randomUUID();
    const expiresAt = new Date(Date.now() + 86_400_000);

    await registry.record({
      grantId,
      missionExternalKey: mission,
      userId: ownerId,
      service: "mission-engine",
      issuedAt: new Date(),
      expiresAt,
    });

    expect(await registry.find(grantId)).toMatchObject({
      grantId,
      status: "ACTIVE",
      retiredAt: null,
    });

    const at = new Date();
    expect(await registry.retireMission(mission, "COMPLETED", at)).toBe(1);
    expect(await registry.find(grantId)).toMatchObject({ status: "COMPLETED" });
    // Idempotent : un second retrait ne réécrit rien.
    expect(await registry.retireMission(mission, "COMPLETED", new Date())).toBe(0);
  });

  it("retire toutes les assertions actives d'une mission en une écriture", async () => {
    const registry = new PrismaMissionGrantRegistry(prisma);
    const rotated = `${mission}-rotation`;
    for (let index = 0; index < 3; index += 1) {
      await registry.record({
        grantId: randomUUID(),
        missionExternalKey: rotated,
        userId: ownerId,
        service: "mission-engine",
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }

    expect(await registry.retireMission(rotated, "REVOKED", new Date())).toBe(3);
    const all = await registry.listByMission(rotated);
    expect(all.every((grant) => grant.status === "REVOKED")).toBe(true);
    expect(all.every((grant) => grant.retiredAt !== null)).toBe(true);
  });

  it("laisse la base refuser un état et un horodatage contradictoires", async () => {
    // La contrainte `CHECK` de la migration : une assertion active ne peut pas
    // porter de date de retrait, et un retrait ne peut pas en manquer. Sans
    // elle, un bug applicatif produirait des lignes qu'on ne saurait pas lire.
    const invalid = prisma.missionGrant.create({
      data: {
        id: randomUUID(),
        missionExternalKey: mission,
        userId: ownerId,
        service: "mission-engine",
        expiresAt: new Date(Date.now() + 86_400_000),
        status: "ACTIVE",
        retiredAt: new Date(),
      },
    });
    await expect(invalid).rejects.toThrow();
  });
});

describe("délégations de calendrier sur PostgreSQL", () => {
  it("ne conserve que le hash, lie le calendrier et révoque atomiquement", async () => {
    const registry = new PrismaScheduleGrantRegistry(prisma);
    const id = randomUUID();
    const scheduleId = randomUUID();
    const tokenHash = "a".repeat(64);
    await registry.record({
      id,
      tokenHash,
      userId: ownerId,
      missionExternalKey: "nexus-scheduled-pg",
      scheduleId,
      status: "ACTIVE",
      createdAt: new Date(),
      revokedAt: null,
    });

    expect(await registry.findByTokenHash(tokenHash)).toMatchObject({
      id,
      scheduleId,
      status: "ACTIVE",
    });
    await registry.revoke(id, new Date());
    expect(await registry.findByTokenHash(tokenHash)).toMatchObject({
      status: "REVOKED",
    });
  });

  it("laisse PostgreSQL refuser deux délégations pour le même calendrier", async () => {
    const scheduleId = randomUUID();
    const base = {
      userId: ownerId,
      missionExternalKey: "nexus-scheduled-unique",
      scheduleId,
      status: "ACTIVE" as const,
      createdAt: new Date(),
      revokedAt: null,
    };
    await prisma.scheduleGrant.create({
      data: { ...base, id: randomUUID(), tokenHash: "b".repeat(64) },
    });
    await expect(
      prisma.scheduleGrant.create({
        data: { ...base, id: randomUUID(), tokenHash: "c".repeat(64) },
      }),
    ).rejects.toThrow();
  });
});
