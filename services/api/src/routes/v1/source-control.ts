/**
 * NEXUS API - Source Control & Pull Request Routes
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SourceControlService } from "@nexus/vcs";
import {
  SourceControlLinkSchema,
  PullRequestReviewGuideSchema,
  SourceControlProviderSchema,
  ReviewStateSchema,
  ChecksStateSchema,
} from "@nexus/protocol";

const scService = new SourceControlService();

export const sourceControlRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  // GET /source-control/links
  app.get(
    "/source-control/links",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "source-control"],
        summary: "List all linked pull requests for a workspace or thread",
        querystring: z.object({
          threadId: z.string().optional(),
        }),
        response: {
          200: z.object({
            links: z.array(SourceControlLinkSchema),
          }),
        },
      },
    },
    async (request, reply) => {
      const { threadId } = request.query;
      const links = scService.listLinks(threadId);
      return reply.send({ links });
    },
  );

  // POST /source-control/links
  app.post(
    "/source-control/links",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "source-control"],
        summary: "Link a pull request to a conversation thread",
        body: z.object({
          provider: SourceControlProviderSchema,
          repoUrl: z.string().url(),
          pullRequestNumber: z.number().int().positive().optional(),
          branch: z.string().min(1),
          headSha: z.string().min(7).max(40).optional(),
          checksState: ChecksStateSchema.optional(),
          reviewState: ReviewStateSchema.optional(),
          watched: z.boolean().optional(),
          threadId: z.string().optional(),
        }),
        response: {
          201: z.object({
            link: SourceControlLinkSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const link = scService.linkPullRequest(request.body);
      return reply.status(201).send({ link });
    },
  );

  // DELETE /source-control/links/:id
  app.delete(
    "/source-control/links/:id",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "source-control"],
        summary: "Unlink a pull request from a thread",
        params: z.object({
          id: z.string().min(1),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const success = scService.unlinkPullRequest(id);
      return reply.send({ success });
    },
  );

  // GET /source-control/guides/:prNumber
  app.get(
    "/source-control/guides/:prNumber",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "source-control"],
        summary: "Read architectural review guide for a pull request",
        params: z.object({
          prNumber: z.coerce.number().int().positive(),
        }),
        response: {
          200: z.object({
            guide: PullRequestReviewGuideSchema.nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { prNumber } = request.params;
      const guide = scService.readReviewGuide(prNumber) ?? null;
      return reply.send({ guide });
    },
  );

  // POST /source-control/guides
  app.post(
    "/source-control/guides",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["vcs", "source-control"],
        summary: "Write or update an architectural review guide",
        body: z.object({
          repoUrl: z.string().url(),
          prNumber: z.number().int().positive(),
          summary: z.string().min(1),
          architectureNotes: z.string().optional(),
          criticalPaths: z.array(z.string()).optional(),
          suggestedCheckpoints: z.array(z.string()).optional(),
        }),
        response: {
          201: z.object({
            guide: PullRequestReviewGuideSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const guide = {
        guideId: `guide-${request.body.prNumber}-${Date.now()}`,
        repoUrl: request.body.repoUrl,
        prNumber: request.body.prNumber,
        summary: request.body.summary,
        architectureNotes: request.body.architectureNotes,
        criticalPaths: request.body.criticalPaths ?? [],
        suggestedCheckpoints: request.body.suggestedCheckpoints ?? [],
        updatedAt: new Date().toISOString(),
      };
      scService.writeReviewGuide(guide);
      return reply.status(201).send({ guide });
    },
  );

  done();
};
