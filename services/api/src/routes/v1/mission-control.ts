import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { DependencyError } from "@nexus/shared";
import {
  addPaperQuoteSchema,
  auditVerificationSchema,
  createPaperAccountSchema,
  createPaperMarketSchema,
  createMissionScheduleSchema,
  missionControlHealthSchema,
  missionSnapshotSchema,
  missionScheduleSchema,
  paperAccountSchema,
  paperAccountsSchema,
  paperMarketSchema,
  paperMarketsSchema,
  paperQuoteSchema,
  researchMissionResponseSchema,
  researchRunSchema,
  researchRunsSchema,
  scheduleRunsSchema,
  submitResearchMissionSchema,
  type MissionControlPort,
  type MissionSchedule,
} from "@nexus/mission-control-client";
import { ok, okSchema } from "../../lib/response.js";
import { currentUser } from "../../plugins/authentication.js";
import { missionOwnerPrefix } from "../../services/acp-orchestrator.js";
import { NotFoundError } from "../../services/stores.js";

const idParams = z.object({ id: z.string().uuid() });

const statusSchema = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  detail: z.string(),
  health: missionControlHealthSchema.nullable(),
  audit: auditVerificationSchema.nullable(),
  accounts: paperAccountsSchema.shape.accounts,
  markets: paperMarketsSchema.shape.markets,
  recent_runs: researchRunsSchema.shape.runs,
  missions: z.array(missionSnapshotSchema),
  schedules: z.array(missionScheduleSchema),
});

/**
 * Pont administrateur vers NEXUS Mission Engine.
 *
 * Le navigateur ne joint jamais le port 18100. Nexus authentifie l'utilisateur,
 * valide les contrats puis parle au service local. Les calendriers reçoivent
 * côté serveur une clé propriétaire et un workspace isolé : le navigateur ne
 * choisit jamais un chemin sur la machine hôte.
 */
export const missionControlRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/dashboard/mission-control",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        response: { 200: okSchema(statusSchema) },
      },
    },
    async (request) => {
      const client = app.services.missionControl;
      if (client === undefined) {
        return ok(
          {
            configured: false,
            reachable: false,
            detail: "Mission Control non configuré",
            health: null,
            audit: null,
            accounts: [],
            markets: [],
            recent_runs: [],
            missions: [],
            schedules: [],
          },
          request.id,
        );
      }
      try {
        const { userId } = currentUser(request);
        const [health, audit, accounts, markets, recentRuns, missions, schedules] =
          await Promise.all([
            client.health(),
            client.verifyAudit(),
            client.listPaperAccounts(20),
            client.listPaperMarkets(20),
            client.listResearchRuns(50),
            client.listMissions(50, `${missionOwnerPrefix(userId)}-`),
            client.listSchedules(200),
          ]);
        return ok(
          {
            configured: true,
            reachable: true,
            detail: "joignable",
            health,
            audit,
            accounts,
            markets,
            recent_runs: recentRuns,
            missions,
            schedules: schedules.filter((schedule) => isOwnedSchedule(schedule, userId)),
          },
          request.id,
        );
      } catch {
        return ok(
          {
            configured: true,
            reachable: false,
            detail: "Mission Control injoignable ou contrat invalide",
            health: null,
            audit: null,
            accounts: [],
            markets: [],
            recent_runs: [],
            missions: [],
            schedules: [],
          },
          request.id,
        );
      }
    },
  );

  app.post(
    "/mission-control/schedules",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        body: createMissionScheduleSchema,
        response: { 200: okSchema(missionScheduleSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const scheduleKey = randomUUID();
      const externalKey = `${missionOwnerPrefix(userId)}-schedule-${scheduleKey}`;
      const workspace = resolve(process.cwd(), ".nexus-workspaces", `schedule-${scheduleKey}`);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const created = await required(app.services.missionControl).createSchedule({
        ...request.body,
        mission: { ...request.body.mission, external_key: externalKey, workspace },
      });
      return ok(created, request.id);
    },
  );

  app.get(
    "/mission-control/schedules/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        params: idParams,
        response: { 200: okSchema(missionScheduleSchema) },
      },
    },
    async (request) => {
      const client = required(app.services.missionControl);
      const { userId } = currentUser(request);
      return ok(await ownedSchedule(client, request.params.id, userId), request.id);
    },
  );

  app.get(
    "/mission-control/schedules/:id/runs",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        params: idParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: okSchema(scheduleRunsSchema) },
      },
    },
    async (request) => {
      const client = required(app.services.missionControl);
      const { userId } = currentUser(request);
      await ownedSchedule(client, request.params.id, userId);
      return ok(
        { runs: await client.listScheduleRuns(request.params.id, request.query.limit) },
        request.id,
      );
    },
  );

  for (const action of ["pause", "resume"] as const) {
    app.post(
      `/mission-control/schedules/:id/${action}`,
      {
        preHandler: app.requireAdmin,
        schema: {
          tags: ["mission-control"],
          params: idParams,
          response: { 200: okSchema(missionScheduleSchema) },
        },
      },
      async (request) => {
        const client = required(app.services.missionControl);
        const { userId } = currentUser(request);
        await ownedSchedule(client, request.params.id, userId);
        const schedule =
          action === "pause"
            ? await client.pauseSchedule(request.params.id)
            : await client.resumeSchedule(request.params.id);
        return ok(schedule, request.id);
      },
    );
  }

  app.post(
    "/mission-control/paper/accounts",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        body: createPaperAccountSchema,
        response: { 200: okSchema(paperAccountSchema) },
      },
    },
    async (request) =>
      ok(await required(app.services.missionControl).createPaperAccount(request.body), request.id),
  );

  app.get(
    "/mission-control/paper/accounts/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        params: idParams,
        response: { 200: okSchema(paperAccountSchema) },
      },
    },
    async (request) =>
      ok(
        await required(app.services.missionControl).getPaperAccount(request.params.id),
        request.id,
      ),
  );

  app.post(
    "/mission-control/paper/markets",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        body: createPaperMarketSchema,
        response: { 200: okSchema(paperMarketSchema) },
      },
    },
    async (request) =>
      ok(await required(app.services.missionControl).createPaperMarket(request.body), request.id),
  );

  app.get(
    "/mission-control/paper/markets/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        params: idParams,
        response: { 200: okSchema(paperMarketSchema) },
      },
    },
    async (request) =>
      ok(await required(app.services.missionControl).getPaperMarket(request.params.id), request.id),
  );

  app.post(
    "/mission-control/paper/markets/:id/quotes",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        params: idParams,
        body: addPaperQuoteSchema,
        response: { 200: okSchema(paperQuoteSchema) },
      },
    },
    async (request) =>
      ok(
        await required(app.services.missionControl).addPaperQuote(request.params.id, request.body),
        request.id,
      ),
  );

  app.post(
    "/mission-control/research-missions",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        headers: z.object({ "idempotency-key": z.string().min(1).max(128) }),
        body: submitResearchMissionSchema,
        response: { 200: okSchema(researchMissionResponseSchema) },
      },
    },
    async (request) =>
      ok(
        await required(app.services.missionControl).submitResearchMission(
          request.body,
          request.headers["idempotency-key"],
        ),
        request.id,
      ),
  );

  app.get(
    "/mission-control/research-runs/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["mission-control"],
        params: idParams,
        response: { 200: okSchema(researchRunSchema) },
      },
    },
    async (request) =>
      ok(await required(app.services.missionControl).getResearchRun(request.params.id), request.id),
  );

  done();
};

function required(client: MissionControlPort | undefined): MissionControlPort {
  if (client !== undefined) return client;
  throw new DependencyError({ message: "Mission Control integration is not configured" });
}

function isOwnedSchedule(schedule: MissionSchedule, userId: string): boolean {
  return schedule.mission.external_key.startsWith(`${missionOwnerPrefix(userId)}-`);
}

async function ownedSchedule(
  client: MissionControlPort,
  scheduleId: string,
  userId: string,
): Promise<MissionSchedule> {
  const schedule = await client.getSchedule(scheduleId);
  if (!isOwnedSchedule(schedule, userId)) throw new NotFoundError("Calendrier", scheduleId);
  return schedule;
}
