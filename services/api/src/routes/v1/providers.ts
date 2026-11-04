/**
 * NEXUS API - Provider & Model Catalog Routes
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ModelCatalog, ProviderHub } from "@nexus/agent-core";
import {
  ProviderTypeSchema,
  ProviderCapabilitiesSchema,
  ModelDescriptorSchema,
} from "@nexus/protocol";

const catalog = new ModelCatalog();
const providerHub = new ProviderHub(catalog);

export const providerRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  // GET /providers/models
  app.get(
    "/providers/models",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["providers", "models"],
        summary: "List canonical and custom models available across providers",
        querystring: z.object({
          provider: ProviderTypeSchema.optional(),
        }),
        response: {
          200: z.object({
            models: z.array(ModelDescriptorSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { provider } = request.query;
      const models = catalog.listModels(provider);
      return reply.send({ models });
    },
  );

  // GET /providers/capabilities
  app.get(
    "/providers/capabilities",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["providers"],
        summary: "List capabilities of supported provider drivers",
        response: {
          200: z.object({
            providers: z.array(
              z.object({
                id: ProviderTypeSchema,
                displayName: z.string(),
                capabilities: ProviderCapabilitiesSchema,
              }),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      const drivers = providerHub.listDrivers();
      const providers = drivers.map((d) => ({
        id: d.id,
        displayName: d.displayName,
        capabilities: d.capabilities,
      }));
      return reply.send({ providers });
    },
  );

  // GET /providers (alias to /providers/capabilities)
  app.get(
    "/providers",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["providers"],
        summary: "List all supported unified provider drivers",
        response: {
          200: z.object({
            providers: z.array(
              z.object({
                id: ProviderTypeSchema,
                displayName: z.string(),
                capabilities: ProviderCapabilitiesSchema,
              }),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      const drivers = providerHub.listDrivers();
      const providers = drivers.map((d) => ({
        id: d.id,
        displayName: d.displayName,
        capabilities: d.capabilities,
      }));
      return reply.send({ providers });
    },
  );

  // GET /providers/:provider/models
  app.get(
    "/providers/:provider/models",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["providers", "models"],
        summary: "List models supported by a specific provider driver",
        params: z.object({
          provider: ProviderTypeSchema,
        }),
        response: {
          200: z.object({
            models: z.array(ModelDescriptorSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const models = catalog.listModels(provider);
      return reply.send({ models });
    },
  );

  // POST /providers/:provider/validate
  app.post(
    "/providers/:provider/validate",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["providers"],
        summary: "Validate provider API credentials",
        params: z.object({
          provider: ProviderTypeSchema,
        }),
        body: z.object({
          credentials: z.record(z.string(), z.string()).optional(),
        }),
        response: {
          200: z.object({
            valid: z.boolean(),
            error: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const driver = providerHub.getDriver(provider);
      if (!driver) {
        return reply.send({ valid: false, error: `Provider ${provider} not found` });
      }
      const res = await driver.validateCredentials(request.body?.credentials);
      return reply.send(res);
    },
  );

  done();
};
