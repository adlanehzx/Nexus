import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { NotFoundError } from "../../services/stores.js";

/**
 * Authentication.
 *
 * These routes are the only ones in the service that receive a password, and the
 * only ones that warrant a tighter rate limit than the global setting:
 * an email and a password can be guessed, whereas a signed token cannot.
 */

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  /** `ADMIN` unlocks the supervision dashboard. */
  role: z.string(),
  status: z.string(),
  createdAt: z.date(),
});

const tokensSchema = z.object({
  accessToken: z.string(),
  accessExpiresAt: z.date(),
  refreshToken: z.string(),
  refreshExpiresAt: z.date(),
});

/**
 * Login rate limit.
 *
 * Five attempts per minute per IP address. The count is tracked per IP
 * rather than per email address: counting per email would allow locking someone
 * else's account by deliberately failing on their behalf.
 */
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

export const authRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/auth/setup-status",
    {
      schema: {
        tags: ["auth"],
        summary: "Reports whether first-run account setup is complete",
        response: { 200: okSchema(z.object({ initialized: z.boolean() })) },
      },
    },
    async (request) =>
      ok({ initialized: (await app.services.users.count()) > 0 }, request.id),
  );

  app.post(
    "/auth/register",
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      schema: {
        tags: ["auth"],
        summary: "Creates an account and opens a session",
        body: z.object({
          email: z.email(),
          displayName: z.string().min(1).max(120),
          password: z.string().min(12).max(1_024),
        }),
        response: { 201: okSchema(z.object({ user: userSchema, tokens: tokensSchema })) },
      },
    },
    async (request, reply) => {
      const result = await app.services.auth.register(request.body);
      return reply.code(201).send(ok(result, request.id));
    },
  );

  app.post(
    "/auth/login",
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      schema: {
        tags: ["auth"],
        summary: "Opens a session",
        body: z.object({ email: z.email(), password: z.string().min(1).max(1_024) }),
        response: { 200: okSchema(z.object({ user: userSchema, tokens: tokensSchema })) },
      },
    },
    async (request) => {
      try {
        const result = await app.services.auth.login(request.body);
        app.services.securityLog.record({
          kind: "auth.login",
          userId: result.user.id,
          summary: `Login of ${result.user.email}`,
        });
        return ok(result, request.id);
      } catch (cause) {
        // A failed login is the most informative security event:
        // it reveals an intrusion attempt. **The attempted address is not logged**
        // — it may belong to someone else, and passwords never appear anywhere.
        app.services.securityLog.record({
          kind: "auth.login_failed",
          summary: "Login attempt rejected",
          context: { ip: request.ip },
        });
        throw cause;
      }
    },
  );

  app.post(
    "/auth/refresh",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Rotates session token",
        body: z.object({ refreshToken: z.string().min(1) }),
        response: { 200: okSchema(tokensSchema) },
      },
    },
    async (request) => {
      const tokens = await app.services.auth.refresh(request.body.refreshToken);
      return ok(tokens, request.id);
    },
  );

  app.post(
    "/auth/logout",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["auth"],
        summary: "Closes current session",
        response: { 200: okSchema(z.object({ closed: z.boolean() })) },
      },
    },
    async (request) => {
      const { sessionId, userId } = currentUser(request);
      await app.services.auth.logout(sessionId);
      app.services.securityLog.record({ kind: "auth.logout", userId, summary: "Logout" });
      return ok({ closed: true }, request.id);
    },
  );

  app.post(
    "/auth/logout-all",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["auth"],
        summary: "Closes all user sessions",
        response: { 200: okSchema(z.object({ closed: z.number().int().nonnegative() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const closed = await app.services.auth.logoutAll(userId);
      return ok({ closed }, request.id);
    },
  );
  done();
};

export const userRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/users/me",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["users"],
        summary: "Authenticated user profile",
        response: { 200: okSchema(userSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const user = await app.services.users.findById(userId);

      // The token was valid but the user no longer exists: account deleted
      // while the session was active.
      if (user === undefined) throw new NotFoundError("User", userId);
      return ok(user, request.id);
    },
  );

  app.get(
    "/users/me/permissions",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["users"],
        summary: "Effective permissions across all sources",
        response: { 200: okSchema(z.object({ permissions: z.array(z.string()) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok({ permissions: await app.services.permissionsFor(userId) }, request.id);
    },
  );
  done();
};
