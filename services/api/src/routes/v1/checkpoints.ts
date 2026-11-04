/**
 * NEXUS API - Checkpoint & Rollback Routes
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as NodePath from "node:path";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AuthorizationError } from "@nexus/shared";
import { CheckpointManager } from "@nexus/vcs";
import { CheckpointSchema, RollbackResultSchema, ThreadTurnDiffSchema } from "@nexus/protocol";

const checkpointManager = new CheckpointManager();

function assertSafePath(pathToCheck: string): void {
  const normalized = NodePath.normalize(pathToCheck.trim());
  if (
    normalized === "/" ||
    ["/etc", "/sys", "/proc", "/dev", "/boot", "/root", "/var/run"].some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    )
  ) {
    throw new AuthorizationError({
      message: `Access to system path '${pathToCheck}' is strictly forbidden.`,
      userMessage: "Access to system path is forbidden.",
    });
  }
}

export const checkpointRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
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
      const { threadId } = request.params;
      try {
        const checkpoints = await checkpointManager.listCheckpoints(threadId);
        return reply.send({ checkpoints });
      } catch {
        if (app.prisma?.checkpoint) {
          const dbCheckpoints = await app.prisma.checkpoint.findMany({
            where: { threadId },
            orderBy: { turnNumber: "asc" },
          });
          const mapped = dbCheckpoints.map((c) => ({
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
          return reply.send({ checkpoints: mapped });
        }
        return reply.send({ checkpoints: [] });
      }
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
      assertSafePath(request.body.cwd);
      const checkpoint = await checkpointManager.captureCheckpoint(request.body);
      if (app.prisma?.checkpoint) {
        try {
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
        } catch {
          // Non-blocking fallback
        }
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
      assertSafePath(request.body.cwd);
      const result = await checkpointManager.restoreCheckpoint(request.body);
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
      const { threadId } = request.params;
      const { fromTurn, toTurn, cwd } = request.query;
      assertSafePath(cwd);
      const diff = await checkpointManager.getTurnDiff(threadId, fromTurn, toTurn, cwd);
      return reply.send({ diff });
    },
  );

  done();
};
