/**
 * NEXUS Unified VCS & Worktrees - Worktree REST API Routes
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import * as path from "node:path";
import { WorktreeManager } from "@nexus/vcs";
import { WorktreeSchema, type WorktreeStrategy, type WorktreeStatus } from "@nexus/protocol";
import { AuthorizationError } from "@nexus/shared";
import { currentUser } from "../../plugins/authentication.js";

function isSystemPath(p: string): boolean {
  const normalized = path.resolve(p);
  return (
    normalized === "/" ||
    ["/etc", "/sys", "/proc", "/dev", "/boot", "/root", "/var/run"].some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    )
  );
}

function assertSafePath(pathToCheck: string): void {
  if (isSystemPath(pathToCheck)) {
    throw new AuthorizationError({
      message: `Access to system path '${pathToCheck}' is strictly forbidden.`,
      userMessage: "Access to system path is forbidden.",
    });
  }
}

export const worktreeRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const worktreeManager = new WorktreeManager();

  // GET /worktrees?workspaceRoot=...
  app.get(
    "/worktrees",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "worktrees"],
        summary: "List all active worktrees for a workspace",
        querystring: z.object({
          workspaceRoot: z.string().default("."),
        }),
        response: {
          200: z.object({
            worktrees: z.array(WorktreeSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { workspaceRoot } = request.query;
      assertSafePath(workspaceRoot);
      try {
        const worktrees = await worktreeManager.listWorktrees(workspaceRoot);
        return reply.send({ worktrees });
      } catch {
        if (app.prisma?.worktree) {
          const dbWorktrees = await app.prisma.worktree.findMany({
            where: { status: "active" },
            orderBy: { createdAt: "desc" },
          });
          const mapped = dbWorktrees.map((w) => ({
            id: w.id,
            path: w.path,
            branch: w.branch,
            headCommit: w.headCommit ?? undefined,
            baseBranch: w.baseBranch ?? undefined,
            workspaceRoot: w.workspaceRoot,
            strategy: (w.strategy as WorktreeStrategy) ?? "isolated",
            status: (w.status as WorktreeStatus) ?? "active",
            isDetached: w.isDetached,
            createdAt: w.createdAt.toISOString(),
            updatedAt: w.updatedAt.toISOString(),
          }));
          return reply.send({ worktrees: mapped });
        }
        return reply.send({ worktrees: [] });
      }
    },
  );

  // POST /worktrees
  app.post(
    "/worktrees",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "worktrees"],
        summary: "Create a new isolated worktree for agent mission execution",
        body: z.object({
          workspaceRoot: z.string().min(1),
          branchName: z.string().min(1),
          baseBranch: z.string().optional(),
          targetPath: z.string().optional(),
          strategy: z.enum(["inherit", "branch", "share", "isolated"]).optional(),
        }),
        response: {
          201: z.object({
            worktree: WorktreeSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      assertSafePath(request.body.workspaceRoot);
      if (request.body.targetPath) {
        assertSafePath(request.body.targetPath);
      }
      const worktree = await worktreeManager.createWorktree(request.body);
      if (app.prisma?.worktree) {
        try {
          const user = currentUser(request);
          await app.prisma.worktree.upsert({
            where: { id: worktree.id },
            update: {
              status: worktree.status,
              headCommit: worktree.headCommit ?? null,
            },
            create: {
              id: worktree.id,
              userId: user.userId,
              path: worktree.path,
              branch: worktree.branch,
              headCommit: worktree.headCommit ?? null,
              baseBranch: worktree.baseBranch ?? null,
              workspaceRoot: worktree.workspaceRoot,
              strategy: worktree.strategy,
              status: worktree.status,
              isDetached: worktree.isDetached,
            },
          });
        } catch {
          // Non-blocking DB fallback
        }
      }
      return reply.status(201).send({ worktree });
    },
  );

  // GET /worktrees/status?worktreePath=...
  app.get(
    "/worktrees/status",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "worktrees"],
        summary: "Get git status of a worktree",
        querystring: z.object({
          worktreePath: z.string().min(1),
          workspaceRoot: z.string().min(1).optional(),
        }),
        response: {
          200: z.object({
            clean: z.boolean(),
            branch: z.string(),
            stagedCount: z.number(),
            unstagedCount: z.number(),
            untrackedCount: z.number(),
            files: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const { worktreePath, workspaceRoot = worktreePath } = request.query;
      assertSafePath(worktreePath);
      assertSafePath(workspaceRoot);
      const status = await worktreeManager.getStatus(worktreePath, workspaceRoot);
      return reply.send({
        clean: status.clean,
        branch: status.worktree.branch,
        stagedCount: 0,
        unstagedCount: status.modifiedFiles.length,
        untrackedCount: status.untrackedFiles.length,
        files: [...status.modifiedFiles, ...status.untrackedFiles],
      });
    },
  );

  // POST /worktrees/handoff
  app.post(
    "/worktrees/handoff",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "worktrees"],
        summary: "Handoff changes from one worktree to target branch or workspace",
        body: z.object({
          worktreePath: z.string().min(1),
          targetBranch: z.string().min(1),
          commitMessage: z.string().min(1),
          autoMerge: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            commitSha: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      assertSafePath(request.body.worktreePath);
      const result = await worktreeManager.handoff({
        worktreePath: request.body.worktreePath,
        targetBranch: request.body.targetBranch,
        commitMessage: request.body.commitMessage,
        ...(request.body.autoMerge !== undefined ? { autoMerge: request.body.autoMerge } : {}),
      });
      return reply.send({
        success: true,
        commitSha: result.commitSha,
      });
    },
  );

  // DELETE /worktrees
  app.delete(
    "/worktrees",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "worktrees"],
        summary: "Remove an isolated worktree",
        body: z.object({
          workspaceRoot: z.string().min(1),
          worktreePath: z.string().min(1),
          force: z.boolean().optional(),
          deleteBranch: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      assertSafePath(request.body.workspaceRoot);
      assertSafePath(request.body.worktreePath);
      await worktreeManager.removeWorktree(request.body);
      if (app.prisma?.worktree) {
        try {
          await app.prisma.worktree.updateMany({
            where: { path: request.body.worktreePath },
            data: { status: "removed" },
          });
        } catch {
          // Non-blocking
        }
      }
      return reply.send({ success: true });
    },
  );

  done();
};
