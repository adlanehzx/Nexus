/**
 * NEXUS API - Checkpoint & Rollback Routes
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CheckpointManager } from "@nexus/vcs";
import { CheckpointSchema, RollbackResultSchema, ThreadTurnDiffSchema } from "@nexus/protocol";
import { currentUser } from "../../plugins/authentication.js";
import { checkpointThread } from "../../services/file-workspaces.js";

export const checkpointRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const checkpointManager = new CheckpointManager();
  // GET /checkpoints/:threadId
  app.get(
    "/checkpoints/:threadId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "checkpoints"],
        summary: "List all captured checkpoints for an agent thread",
        params: z.object({
          threadId: z.string().min(1),
        }),
        response: {
          200: z.object({
            checkpoints: z.array(CheckpointSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const threadId = checkpointThread(userId, request.params.threadId);
      let checkpoints;
      if (app.prisma?.checkpoint) {
        const stored = await app.prisma.checkpoint.findMany({
          where: { threadId },
          orderBy: { turnNumber: "asc" },
        });
        checkpoints = stored.map((c) => ({
          id: c.id,
          threadId: c.threadId,
          turnNumber: c.turnNumber,
          commitHash: c.commitHash ?? undefined,
          diffBlob: c.diffBlob ?? undefined,
          description: c.description ?? undefined,
          snapshotRoot: c.snapshotRoot ?? undefined,
          createdAt: c.createdAt.toISOString(),
          createdBy: c.createdBy ?? undefined,
        }));
      } else {
        checkpoints = await checkpointManager.listCheckpoints(threadId);
      }
      // Revoked folders must disappear from history as well as reject file actions.
      const visible = [];
      for (const checkpoint of checkpoints) {
        if (!checkpoint.snapshotRoot) continue;
        try {
          await app.services.fileWorkspaces.authorizeRepository(userId, checkpoint.snapshotRoot);
          visible.push(checkpoint);
        } catch {
          // Missing or revoked workspace: do not expose cached file contents.
        }
      }
      return reply.send({ checkpoints: visible });
    },
  );

  // POST /checkpoints
  app.post(
    "/checkpoints",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "checkpoints"],
        summary: "Capture a differential checkpoint snapshot for an agent turn",
        body: z.object({
          threadId: z.string().min(1),
          turnNumber: z.number().int().nonnegative(),
          cwd: z.string().min(1),
          description: z.string().optional(),
        }),
        response: {
          201: z.object({
            checkpoint: CheckpointSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const cwd = await app.services.fileWorkspaces.authorizeRepository(userId, request.body.cwd);
      const checkpoint = await checkpointManager.captureCheckpoint({
        ...request.body,
        cwd,
        threadId: checkpointThread(userId, request.body.threadId),
        createdBy: userId,
        snapshotRoot: cwd,
      });
      if (app.prisma?.checkpoint) {
        await app.prisma.checkpoint.create({
          data: {
            id: checkpoint.id,
            threadId: checkpoint.threadId,
            turnNumber: checkpoint.turnNumber,
            commitHash: checkpoint.commitHash ?? null,
            diffBlob: checkpoint.diffBlob ?? null,
            description: checkpoint.description ?? null,
            snapshotRoot: checkpoint.snapshotRoot ?? null,
            createdBy: checkpoint.createdBy ?? null,
          },
        });
      }
      return reply.status(201).send({ checkpoint });
    },
  );

  // POST /checkpoints/rollback
  app.post(
    "/checkpoints/rollback",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "checkpoints"],
        summary: "Rollback workspace to a designated turn checkpoint",
        body: z.object({
          threadId: z.string().min(1),
          turnNumber: z.number().int().nonnegative(),
          cwd: z.string().min(1),
          checkpointId: z.string().optional(),
          dryRun: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            result: RollbackResultSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const cwd = await app.services.fileWorkspaces.authorizeRepository(userId, request.body.cwd);
      const result = await checkpointManager.restoreCheckpoint({
        ...request.body,
        cwd,
        threadId: checkpointThread(userId, request.body.threadId),
      });
      return reply.send({ result });
    },
  );

  // GET /checkpoints/:threadId/diff
  app.get(
    "/checkpoints/:threadId/diff",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "checkpoints"],
        summary: "Compute turn diff between two agent turns",
        params: z.object({
          threadId: z.string().min(1),
        }),
        querystring: z.object({
          fromTurn: z.coerce.number().int().nonnegative(),
          toTurn: z.coerce.number().int().nonnegative(),
          cwd: z.string().min(1),
        }),
        response: {
          200: z.object({
            diff: ThreadTurnDiffSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const threadId = checkpointThread(currentUser(request).userId, request.params.threadId);
      const { fromTurn, toTurn } = request.query;
      const cwd = await app.services.fileWorkspaces.authorizeRepository(
        currentUser(request).userId,
        request.query.cwd,
      );
      const diff = await checkpointManager.getTurnDiff(threadId, fromTurn, toTurn, cwd);
      return reply.send({ diff });
    },
  );

  done();
};
