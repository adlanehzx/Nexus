import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { fileWorkspaceSchema } from "../../services/file-workspaces.js";

export const fileWorkspaceRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/file-workspaces",
    {
      preHandler: app.requireUser,
      schema: { response: { 200: z.object({ workspaces: z.array(fileWorkspaceSchema) }) } },
    },
    async (request) => ({
      workspaces: await app.services.fileWorkspaces.list(currentUser(request).userId),
    }),
  );
  app.post(
    "/file-workspaces",
    {
      preHandler: app.requireAdmin,
      schema: {
        body: fileWorkspaceSchema
          .omit({ id: true, userId: true })
          .extend({ userId: z.string().uuid().optional() }),
        response: { 201: fileWorkspaceSchema },
      },
    },
    async (request, reply) => {
      const entry = await app.services.fileWorkspaces.save({
        ...request.body,
        id: randomUUID(),
        userId: request.body.userId ?? currentUser(request).userId,
      });
      return reply.status(201).send(entry);
    },
  );
  app.delete(
    "/file-workspaces/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ removed: z.boolean() }) },
      },
    },
    async (request) => {
      await app.services.fileWorkspaces.remove(request.params.id);
      return { removed: true };
    },
  );
  done();
};
