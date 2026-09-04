import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { NotFoundError } from "../../services/stores.js";

/**
 * Authentification.
 *
 * Ces routes sont les seules du service à recevoir un mot de passe, et les
 * seules à mériter une limitation de débit plus serrée que le réglage global :
 * une adresse et un mot de passe se devinent, alors qu'un jeton signé ne se
 * devine pas.
 */

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  /** `ADMIN` ouvre le tableau de bord de supervision. */
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
 * Limitation de débit de la connexion.
 *
 * Cinq tentatives par minute et par adresse IP. Le compte est fait sur l'IP et
 * non sur l'adresse électronique : compter par adresse permettrait de bloquer le
 * compte de quelqu'un d'autre en échouant volontairement à sa place.
 */
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

export const authRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/auth/register",
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      schema: {
        tags: ["auth"],
        summary: "Crée un compte et ouvre une session",
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
        summary: "Ouvre une session",
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
          summary: `Connexion de ${result.user.email}`,
        });
        return ok(result, request.id);
      } catch (cause) {
        // Un échec de connexion est l'événement de sécurité le plus utile qui
        // soit : c'est lui qui trahit une tentative. **L'adresse essayée n'est
        // pas journalisée** — elle appartient peut-être à quelqu'un d'autre, et
        // le mot de passe, lui, n'apparaît nulle part.
        app.services.securityLog.record({
          kind: "auth.login_failed",
          summary: "Tentative de connexion refusée",
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
        summary: "Fait tourner le jeton de session",
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
        summary: "Ferme la session courante",
        response: { 200: okSchema(z.object({ closed: z.boolean() })) },
      },
    },
    async (request) => {
      const { sessionId, userId } = currentUser(request);
      await app.services.auth.logout(sessionId);
      app.services.securityLog.record({ kind: "auth.logout", userId, summary: "Déconnexion" });
      return ok({ closed: true }, request.id);
    },
  );

  app.post(
    "/auth/logout-all",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["auth"],
        summary: "Ferme toutes les sessions de l'utilisateur",
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
        summary: "Profil de l'utilisateur authentifié",
        response: { 200: okSchema(userSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const user = await app.services.users.findById(userId);

      // Le jeton était valide mais l'utilisateur n'existe plus : compte supprimé
      // pendant que la session courait.
      if (user === undefined) throw new NotFoundError("Utilisateur", userId);
      return ok(user, request.id);
    },
  );

  app.get(
    "/users/me/permissions",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["users"],
        summary: "Permissions effectives, toutes sources confondues",
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
