import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  osintMissionInputSchema,
  osintMissionSchema,
  archivedEvidenceSchema,
  osintAlertSchema,
  osintCaseRecordSchema,
  osintEntitySchema,
  osintInvestigationSchema,
  osintRelationSchema,
  osintWatchSchema,
} from "@nexus/osint";
import { SearxngClient } from "@nexus/web-search";
import { NotFoundError } from "@nexus/shared";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

const caseParams = z.object({ caseId: z.string().uuid() });
const entityParams = caseParams.extend({ entityId: z.string().uuid() });
const relationParams = caseParams.extend({ relationId: z.string().uuid() });
const alertParams = caseParams.extend({ alertId: z.string().uuid() });
const watchParams = caseParams.extend({ watchId: z.string().uuid() });

const searchBodySchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});

const searchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const searchResultItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  engines: z.array(z.string()),
  publishedAt: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
});

const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultItemSchema),
  suggestions: z.array(z.string()).default([]),
  answers: z.array(z.string()).default([]),
  numberOfResults: z.number().nullable().optional(),
});

async function executeSearxngSearch(query: string, limit = 10) {
  const searxngUrl = process.env.SEARXNG_URL ?? "http://127.0.0.1:18080";
  const client = new SearxngClient({
    baseUrl: searxngUrl,
    timeoutMs: Number(process.env.SEARXNG_TIMEOUT_MS) || 15_000,
  });
  return client.search({ query, limit });
}

export const osintRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/osint/missions",
    {
      preHandler: app.requireUser,
      schema: { response: { 200: okSchema(z.object({ missions: z.array(osintMissionSchema) })) } },
    },
    async (request) =>
      ok(
        { missions: await app.services.osintMissions.list(currentUser(request).userId) },
        request.id,
      ),
  );
  app.post(
    "/osint/missions",
    {
      preHandler: app.requireUser,
      schema: { body: osintMissionInputSchema, response: { 200: okSchema(osintMissionSchema) } },
    },
    async (request) =>
      ok(
        await app.services.osintMissions.create(currentUser(request).userId, request.body),
        request.id,
      ),
  );
  app.get(
    "/osint/missions/:missionId",
    {
      preHandler: app.requireUser,
      schema: {
        params: z.object({ missionId: z.string().uuid() }),
        response: { 200: okSchema(osintMissionSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osintMissions.get(currentUser(request).userId, request.params.missionId),
        request.id,
      ),
  );
  app.post(
    "/osint/missions/:missionId/control",
    {
      preHandler: app.requireUser,
      schema: {
        params: z.object({ missionId: z.string().uuid() }),
        body: z.object({ action: z.enum(["pause", "resume", "cancel"]) }),
        response: { 200: okSchema(osintMissionSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osintMissions.control(
          currentUser(request).userId,
          request.params.missionId,
          request.body.action,
        ),
        request.id,
      ),
  );

  app.get(
    "/osint/cases",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        response: { 200: okSchema(z.object({ cases: z.array(osintCaseRecordSchema) })) },
      },
    },
    async (request) =>
      ok({ cases: await app.services.osint.list(currentUser(request).userId) }, request.id),
  );

  app.post(
    "/osint/cases",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        body: osintInvestigationSchema,
        response: { 200: okSchema(osintCaseRecordSchema) },
      },
    },
    async (request) =>
      ok(await app.services.osint.create(currentUser(request).userId, request.body), request.id),
  );

  app.get(
    "/osint/cases/:caseId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        response: { 200: okSchema(osintCaseRecordSchema) },
      },
    },
    async (request) => {
      const record = await app.services.osint.get(
        currentUser(request).userId,
        request.params.caseId,
      );
      if (record === undefined)
        throw new NotFoundError({
          message: `Unknown OSINT case: ${request.params.caseId}`,
          userMessage: "The requested OSINT case does not exist.",
        });
      return ok(record, request.id);
    },
  );

  app.post(
    "/osint/cases/:caseId/evidence",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: z.object({
          url: z.string().url(),
          title: z.string().min(1).max(500),
          excerpt: z.string().max(4_000),
          reliability: z.enum(["primary", "corroborated", "unverified"]),
          content: z.string().max(1_000_000),
        }),
        response: { 200: okSchema(archivedEvidenceSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osint.addEvidence(
          currentUser(request).userId,
          request.params.caseId,
          request.body,
        ),
        request.id,
      ),
  );

  app.post(
    "/osint/cases/:caseId/import",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: z.object({ dataset: z.string().min(2).max(2_000_000) }),
        response: { 200: okSchema(z.object({ evidence: z.array(archivedEvidenceSchema) })) },
      },
    },
    async (request) =>
      ok(
        {
          evidence: await app.services.osint.importEvidence(
            currentUser(request).userId,
            request.params.caseId,
            request.body.dataset,
          ),
        },
        request.id,
      ),
  );

  app.post(
    "/osint/cases/:caseId/entities",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: osintEntitySchema.omit({ id: true }),
        response: { 200: okSchema(osintEntitySchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osint.addEntity(
          currentUser(request).userId,
          request.params.caseId,
          request.body,
        ),
        request.id,
      ),
  );

  app.delete(
    "/osint/cases/:caseId/entities/:entityId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: entityParams,
        response: { 200: okSchema(z.object({ deleted: z.literal(true) })) },
      },
    },
    async (request) => {
      try {
        await app.services.osint.deleteEntity(
          currentUser(request).userId,
          request.params.caseId,
          request.params.entityId,
        );
        return ok({ deleted: true }, request.id);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          throw new NotFoundError({
            message: `Entity or case not found: ${request.params.entityId}`,
            userMessage: "The requested entity or case does not exist.",
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/osint/cases/:caseId/relations",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: osintRelationSchema.omit({ id: true }),
        response: { 200: okSchema(osintRelationSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osint.addRelation(
          currentUser(request).userId,
          request.params.caseId,
          request.body,
        ),
        request.id,
      ),
  );

  app.delete(
    "/osint/cases/:caseId/relations/:relationId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: relationParams,
        response: { 200: okSchema(z.object({ deleted: z.literal(true) })) },
      },
    },
    async (request) => {
      try {
        await app.services.osint.deleteRelation(
          currentUser(request).userId,
          request.params.caseId,
          request.params.relationId,
        );
        return ok({ deleted: true }, request.id);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          throw new NotFoundError({
            message: `Relation or case not found: ${request.params.relationId}`,
            userMessage: "The requested relation or case does not exist.",
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/osint/cases/:caseId/watches",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: z.object({
          query: z.string().min(2).max(1_000),
          intervalMinutes: z.number().int().min(15).max(525_600),
        }),
        response: { 200: okSchema(osintWatchSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osint.addWatch(
          currentUser(request).userId,
          request.params.caseId,
          request.body.query,
          request.body.intervalMinutes,
        ),
        request.id,
      ),
  );

  app.post(
    "/osint/cases/:caseId/watches/:watchId/evaluate",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: watchParams,
        body: z.object({ content: z.string().max(1_000_000) }),
        response: { 200: okSchema(z.object({ alert: osintAlertSchema.nullable() })) },
      },
    },
    async (request) =>
      ok(
        {
          alert:
            (await app.services.osint.evaluateWatch(
              currentUser(request).userId,
              request.params.caseId,
              request.params.watchId,
              request.body.content,
            )) ?? null,
        },
        request.id,
      ),
  );

  app.post(
    "/osint/cases/:caseId/alerts/:alertId/acknowledge",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: alertParams,
        response: { 200: okSchema(osintAlertSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osint.acknowledgeAlert(
          currentUser(request).userId,
          request.params.caseId,
          request.params.alertId,
        ),
        request.id,
      ),
  );

  app.post(
    "/osint/cases/:caseId/enrich",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: z.object({
          provider: z.enum([
            "sherlock",
            "dns",
            "rdap",
            "certificate",
            "company_registry",
            "virustotal",
            "shodan",
          ]),
          query: z.string().min(2).max(500),
          secretRef: z
            .string()
            .regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/)
            .optional(),
        }),
        response: { 200: okSchema(archivedEvidenceSchema) },
      },
    },
    async (request) =>
      ok(
        await app.services.osint.enrich(
          currentUser(request).userId,
          request.params.caseId,
          request.body.provider,
          request.body.query,
          request.body.secretRef,
        ),
        request.id,
      ),
  );

  app.get(
    "/osint/cases/:caseId/report",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        querystring: z.object({ format: z.enum(["markdown", "pdf"]).default("markdown") }),
        response: {
          200: okSchema(z.object({ format: z.enum(["markdown", "pdf"]), content: z.string() })),
        },
      },
    },
    async (request) => {
      const report = await app.services.osint.report(
        currentUser(request).userId,
        request.params.caseId,
        request.query.format,
      );
      return ok(
        {
          format: request.query.format,
          content: typeof report === "string" ? report : Buffer.from(report).toString("base64"),
        },
        request.id,
      );
    },
  );

  app.post(
    "/osint/cases/:caseId/search",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        body: searchBodySchema,
        response: { 200: okSchema(searchResponseSchema) },
      },
    },
    async (request) => {
      const record = await app.services.osint.get(
        currentUser(request).userId,
        request.params.caseId,
      );
      if (record === undefined) {
        throw new NotFoundError({
          message: `Unknown OSINT case: ${request.params.caseId}`,
          userMessage: "The requested OSINT case does not exist.",
        });
      }
      const results = await executeSearxngSearch(request.body.query, request.body.limit);
      return ok(results, request.id);
    },
  );

  app.get(
    "/osint/cases/:caseId/search",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        params: caseParams,
        querystring: searchQuerySchema,
        response: { 200: okSchema(searchResponseSchema) },
      },
    },
    async (request) => {
      const record = await app.services.osint.get(
        currentUser(request).userId,
        request.params.caseId,
      );
      if (record === undefined) {
        throw new NotFoundError({
          message: `Unknown OSINT case: ${request.params.caseId}`,
          userMessage: "The requested OSINT case does not exist.",
        });
      }
      const results = await executeSearxngSearch(request.query.query, request.query.limit);
      return ok(results, request.id);
    },
  );

  app.post(
    "/osint/search",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        body: searchBodySchema,
        response: { 200: okSchema(searchResponseSchema) },
      },
    },
    async (request) => {
      const results = await executeSearxngSearch(request.body.query, request.body.limit);
      return ok(results, request.id);
    },
  );

  app.get(
    "/osint/search",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["osint"],
        querystring: searchQuerySchema,
        response: { 200: okSchema(searchResponseSchema) },
      },
    },
    async (request) => {
      const results = await executeSearxngSearch(request.query.query, request.query.limit);
      return ok(results, request.id);
    },
  );

  done();
};
