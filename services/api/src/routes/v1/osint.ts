import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  archivedEvidenceSchema,
  osintAlertSchema,
  osintCaseRecordSchema,
  osintEntitySchema,
  osintInvestigationSchema,
  osintRelationSchema,
  osintWatchSchema,
} from "@nexus/osint";
import { NotFoundError } from "@nexus/shared";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

const caseParams = z.object({ caseId: z.string().uuid() });
const alertParams = caseParams.extend({ alertId: z.string().uuid() });
const watchParams = caseParams.extend({ watchId: z.string().uuid() });

export const osintRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

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

  done();
};
