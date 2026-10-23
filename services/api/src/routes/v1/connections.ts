import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  connectionActionSchema,
  connectionKindSchema,
  connectionPlatformSchema,
  connectionSchema,
} from "@nexus/connections";
import { ok, okSchema } from "../../lib/response.js";

const catalogEntrySchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  kind: connectionKindSchema,
  platforms: z.array(connectionPlatformSchema),
  supportedOnThisHost: z.boolean(),
  actions: z.array(connectionActionSchema),
  docsUrl: z.string().url().nullable(),
  adapter: z.object({
    provenance: z.enum(["official", "community", "unknown"]),
    provenanceEvidence: z.string(),
  }),
  observation: connectionSchema.nullable(),
});

const catalogSchema = z.object({ connections: z.array(catalogEntrySchema) });

/** Administrator-only discovery of local CLIs and their ACP adapter status. */
export const connectionRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/connections",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["connections"],
        summary: "List supported local connection providers and last observations",
        response: { 200: okSchema(catalogSchema) },
      },
    },
    (request) => ok({ connections: app.services.connections.list() }, request.id),
  );

  app.post(
    "/connections/detect",
    {
      preHandler: app.requireAdmin,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["connections"],
        summary: "Safely scan the host for declared providers",
        response: { 200: okSchema(catalogSchema) },
      },
    },
    async (request) => ok({ connections: await app.services.connections.detectAll() }, request.id),
  );

  app.post(
    "/connections/:providerId/test",
    {
      preHandler: app.requireAdmin,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["connections"],
        summary: "Repeat the declared diagnostic for one provider",
        params: z.object({
          providerId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z][a-z0-9_-]*$/),
        }),
        response: { 200: okSchema(catalogEntrySchema) },
      },
    },
    async (request) =>
      ok(await app.services.connections.test(request.params.providerId), request.id),
  );

  app.post(
    "/connections/:providerId/connect",
    {
      preHandler: app.requireAdmin,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["connections"],
        summary: "Initiate or refresh connection to one provider",
        params: z.object({
          providerId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z][a-z0-9_-]*$/),
        }),
        response: { 200: okSchema(catalogEntrySchema) },
      },
    },
    async (request) =>
      ok(await app.services.connections.connect(request.params.providerId), request.id),
  );

  app.post(
    "/connections/:providerId/disconnect",
    {
      preHandler: app.requireAdmin,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["connections"],
        summary: "Disconnect and clear live observation for one provider",
        params: z.object({
          providerId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z][a-z0-9_-]*$/),
        }),
        response: { 200: okSchema(catalogEntrySchema) },
      },
    },
    async (request) =>
      ok(await app.services.connections.disconnect(request.params.providerId), request.id),
  );

  done();
};
