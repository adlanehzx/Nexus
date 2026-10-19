import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { DependencyError } from "@nexus/shared";
import {
  addPaperQuoteSchema,
  auditVerificationSchema,
  createPaperAccountSchema,
  createPaperMarketSchema,
  missionControlHealthSchema,
  missionSnapshotSchema,
  paperAccountSchema,
  paperAccountsSchema,
  paperMarketSchema,
  paperMarketsSchema,
  paperQuoteSchema,
  researchMissionResponseSchema,
  researchRunSchema,
  researchRunsSchema,
  submitResearchMissionSchema,
  type MissionControlPort,
} from "@nexus/mission-control-client";
import { ok, okSchema } from "../../lib/response.js";
import { currentUser } from "../../plugins/authentication.js";
import { missionOwnerPrefix } from "../../services/acp-orchestrator.js";

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
});

/**
 * Pont administrateur vers NEXUS Mission Engine.
 *
 * Le navigateur ne joint jamais le port 18100. Nexus authentifie l'utilisateur,
 * valide les contrats puis parle au service local. Les mutations exposées sont
 * exclusivement celles du simulateur paper-only.
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
          },
          request.id,
        );
      }
      try {
        const { userId } = currentUser(request);
        const [health, audit, accounts, markets, recentRuns, missions] = await Promise.all([
          client.health(),
          client.verifyAudit(),
          client.listPaperAccounts(20),
          client.listPaperMarkets(20),
          client.listResearchRuns(50),
          client.listMissions(50, `${missionOwnerPrefix(userId)}-`),
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
          },
          request.id,
        );
      }
    },
  );

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
