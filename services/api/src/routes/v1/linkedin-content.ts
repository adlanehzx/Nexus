import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  linkedInContentSettingsPatchSchema,
  linkedInEngagementTargetSchema,
  linkedInReactionTypeSchema,
} from "@nexus/linkedin";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import {
  LINKEDIN_ENGAGEMENT_STATES,
  LINKEDIN_POST_STATES,
  type LinkedInAuditRecord,
  type LinkedInEngagementRecord,
  type LinkedInPostRecord,
} from "../../services/linkedin-content/store.js";

const idParamsSchema = z.object({ id: z.string().uuid() });
const emptyBodySchema = z
  .union([z.record(z.string(), z.unknown()), z.undefined(), z.null()])
  .optional();
const isoDate = z.coerce.date();

/**
 * Lab 1 — LinkedIn content management on the member's behalf.
 *
 * Every route is scoped to the authenticated member. Responses carry no token
 * or credential: the official API client is resolved server-side from the
 * vault and never serialised.
 */
export const linkedInContentRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = () => app.services.linkedinContent;

  // ── Settings and consent ────────────────────────────────────────────────

  app.get(
    "/linkedin/content/settings",
    {
      preHandler: [app.requireUser],
      schema: { tags: ["linkedin"], response: { 200: okSchema(z.any()) } },
    },
    async (request) => ok(await service().settingsView(currentUser(request).userId), request.id),
  );

  app.put(
    "/linkedin/content/settings",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        body: linkedInContentSettingsPatchSchema,
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) =>
      ok(await service().updateSettings(currentUser(request).userId, request.body), request.id),
  );

  app.post(
    "/linkedin/content/consent",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        // `accepted: true` must be sent explicitly: no default can consent.
        body: z.object({ accepted: z.literal(true), version: z.number().int().positive() }),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) =>
      ok(
        await service().acceptAutomationRisk(currentUser(request).userId, request.body.version),
        request.id,
      ),
  );

  app.delete(
    "/linkedin/content/consent",
    {
      preHandler: [app.requireUser],
      schema: { tags: ["linkedin"], response: { 200: okSchema(z.any()) } },
    },
    async (request) =>
      ok(await service().revokeAutomationRisk(currentUser(request).userId), request.id),
  );

  app.get(
    "/linkedin/content/audit",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const events = await service().audit(currentUser(request).userId, request.query.limit);
      return ok({ events: events.map(auditView) }, request.id);
    },
  );

  // ── Posts ───────────────────────────────────────────────────────────────

  app.get(
    "/linkedin/content/posts",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        querystring: z.object({
          state: z.enum(LINKEDIN_POST_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const posts = await service().listPosts(currentUser(request).userId, {
        ...(request.query.state === undefined ? {} : { states: [request.query.state] }),
        limit: request.query.limit,
      });
      return ok({ posts: posts.map(postView) }, request.id);
    },
  );

  app.post(
    "/linkedin/content/posts",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        body: z.object({
          text: z.string().trim().min(1).max(3_000),
          scheduledAt: isoDate.nullable().optional(),
          topic: z.string().trim().max(120).nullable().optional(),
        }),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const post = await service().createPost(currentUser(request).userId, {
        text: request.body.text,
        scheduledAt: request.body.scheduledAt ?? null,
        topic: request.body.topic ?? null,
      });
      return ok(postView(post), request.id);
    },
  );

  app.post(
    "/linkedin/content/posts/generate",
    {
      preHandler: [app.requireUser],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["linkedin"],
        body: z
          .object({ topic: z.string().trim().min(1).max(120).optional() })
          .optional()
          .nullable(),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const topic = request.body?.topic;
      const post = await service().generatePost(
        currentUser(request).userId,
        topic === undefined ? {} : { topic },
      );
      return ok(postView(post), request.id);
    },
  );

  app.patch(
    "/linkedin/content/posts/:id",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        params: idParamsSchema,
        body: z
          .object({
            text: z.string().trim().min(1).max(3_000).optional(),
            scheduledAt: isoDate.nullable().optional(),
          })
          .strict(),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const post = await service().updatePost(currentUser(request).userId, request.params.id, {
        ...(request.body.text === undefined ? {} : { text: request.body.text }),
        ...(request.body.scheduledAt === undefined
          ? {}
          : { scheduledAt: request.body.scheduledAt }),
      });
      return ok(postView(post), request.id);
    },
  );

  for (const action of ["approve", "reject", "cancel", "publish"] as const) {
    app.post(
      `/linkedin/content/posts/:id/${action}`,
      {
        preHandler: [app.requireUser],
        schema: {
          tags: ["linkedin"],
          params: idParamsSchema,
          body: emptyBodySchema,
          response: { 200: okSchema(z.any()) },
        },
      },
      async (request) => {
        const { userId } = currentUser(request);
        const id = request.params.id;
        const post =
          action === "approve"
            ? await service().approvePost(userId, id)
            : action === "reject"
              ? await service().rejectPost(userId, id)
              : action === "cancel"
                ? await service().cancelPost(userId, id)
                : await service().publishNow(userId, id);
        return ok(postView(post), request.id);
      },
    );
  }

  // ── Engagement ──────────────────────────────────────────────────────────

  app.get(
    "/linkedin/content/engagements",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        querystring: z.object({
          state: z.enum(LINKEDIN_ENGAGEMENT_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const items = await service().listEngagements(currentUser(request).userId, {
        ...(request.query.state === undefined ? {} : { states: [request.query.state] }),
        limit: request.query.limit,
      });
      return ok({ engagements: items.map(engagementView) }, request.id);
    },
  );

  app.post(
    "/linkedin/content/engagements",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["linkedin"],
        body: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("reaction"),
            target: linkedInEngagementTargetSchema,
            reaction: linkedInReactionTypeSchema.optional(),
            rationale: z.string().trim().max(400).optional(),
          }),
          z.object({
            kind: z.literal("comment"),
            target: linkedInEngagementTargetSchema,
            text: z.string().trim().min(1).max(1_250).optional(),
            rationale: z.string().trim().max(400).optional(),
          }),
        ]),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const body = request.body;
      const record = await service().proposeEngagement(currentUser(request).userId, {
        kind: body.kind,
        target: body.target,
        ...(body.kind === "reaction" && body.reaction !== undefined
          ? { reaction: body.reaction }
          : {}),
        ...(body.kind === "comment" && body.text !== undefined ? { text: body.text } : {}),
        ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
      });
      return ok(engagementView(record), request.id);
    },
  );

  app.post(
    "/linkedin/content/engagements/discover",
    {
      preHandler: [app.requireUser],
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
      schema: {
        tags: ["linkedin"],
        body: z
          .object({ limit: z.number().int().min(1).max(20).default(5) })
          .optional()
          .nullable(),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const result = await service().discover(
        currentUser(request).userId,
        request.body?.limit ?? 5,
      );
      return ok(
        {
          created: result.created.map(engagementView),
          skipped: result.skipped,
          errors: result.errors,
        },
        request.id,
      );
    },
  );

  for (const action of ["approve", "reject", "cancel", "done"] as const) {
    app.post(
      `/linkedin/content/engagements/:id/${action}`,
      {
        preHandler: [app.requireUser],
        schema: {
          tags: ["linkedin"],
          params: idParamsSchema,
          body: emptyBodySchema,
          response: { 200: okSchema(z.any()) },
        },
      },
      async (request) => {
        const { userId } = currentUser(request);
        const id = request.params.id;
        const record =
          action === "approve"
            ? await service().approveEngagement(userId, id)
            : action === "reject"
              ? await service().rejectEngagement(userId, id)
              : action === "cancel"
                ? await service().cancelEngagement(userId, id)
                : await service().markEngagementDone(userId, id);
        return ok(engagementView(record), request.id);
      },
    );
  }

  done();
};

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function postView(post: LinkedInPostRecord) {
  return {
    id: post.id,
    state: post.state,
    text: post.text,
    topic: post.topic,
    visibility: post.visibility,
    scheduledAt: iso(post.scheduledAt),
    publishedAt: iso(post.publishedAt),
    externalId: post.externalId,
    failureReason: post.failureReason,
    createdBy: post.createdBy,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export function engagementView(item: LinkedInEngagementRecord) {
  return {
    id: item.id,
    kind: item.kind,
    target: item.target,
    reaction: item.reaction,
    text: item.text,
    rationale: item.rationale,
    state: item.state,
    executeAfter: iso(item.executeAfter),
    executedAt: iso(item.executedAt),
    executor: item.executor,
    failureReason: item.failureReason,
    createdBy: item.createdBy,
    createdAt: item.createdAt.toISOString(),
  };
}

export function auditView(event: LinkedInAuditRecord) {
  return {
    id: event.id,
    actor: event.actor,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    outcome: event.outcome,
    summary: event.summary,
    context: event.context,
    createdAt: event.createdAt.toISOString(),
  };
}
