import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { AuthenticationError, AuthorizationError } from "@nexus/shared";
import type { Principal } from "@nexus/auth";
import type { ServiceContainer } from "../services/container.js";

/**
 * Authentification des requêtes HTTP.
 *
 * **Deux surfaces, strictement séparées.** Un jeton d'appareil ne donne jamais
 * les droits d'un utilisateur, et réciproquement. La séparation est portée par
 * les jetons eux-mêmes — leurs claims diffèrent, et `verifyAccessToken` refuse
 * un jeton d'appareil — mais elle est aussi rendue explicite ici : les routes
 * déclarent laquelle elles attendent, et il n'existe pas de garde générique qui
 * accepterait les deux sans le dire.
 *
 * La vérification se fait en deux temps :
 *
 *  1. la **signature** prouve que le jeton vient de nous ;
 *  2. la **session** prouve qu'il est toujours valide.
 *
 * Le second temps n'est pas redondant. Un jeton d'accès reste
 * cryptographiquement valide jusqu'à son expiration ; sans consulter la session,
 * une déconnexion ne prendrait effet qu'un quart d'heure plus tard.
 */

declare module "fastify" {
  interface FastifyInstance {
    services: ServiceContainer;
    /** Exige un utilisateur authentifié. */
    requireUser: (request: FastifyRequest) => Promise<void>;
    /** Exige un appareil authentifié. Surface distincte de la précédente. */
    requireDevice: (request: FastifyRequest) => Promise<void>;
    /**
     * Exige un utilisateur **administrateur**.
     *
     * Garde du tableau de bord de supervision, qui donne une vue de tout le
     * système. Un jeton de client ordinaire ne doit pas l'ouvrir : un téléphone
     * perdu exposerait alors l'infrastructure entière en plus de la
     * conversation.
     */
    requireAdmin: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthenticationPluginOptions {
  services: ServiceContainer;
}

/** Extrait le jeton porteur, sans révéler pourquoi il est refusé. */
function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new AuthenticationError({
      message: "En-tête Authorization absent ou mal formé",
      userMessage: "Authentification requise.",
    });
  }

  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    throw new AuthenticationError({ message: "Jeton porteur vide" });
  }
  return token;
}

export const authenticationPlugin = fp<AuthenticationPluginOptions>(
  (app, options, done) => {
    app.decorate("services", options.services);
    app.decorateRequest("principal", undefined);

    app.decorate("requireUser", async (request: FastifyRequest) => {
      const claims = options.services.tokens.verifyAccessToken(bearerToken(request));

      // La session peut avoir été fermée depuis l'émission du jeton. Sans cette
      // vérification, se déconnecter ne ferait rien pendant quinze minutes.
      await options.services.auth.assertSessionActive(claims.sid);

      request.principal = { kind: "user", userId: claims.sub, sessionId: claims.sid };
    });

    /**
     * Le rôle est lu **dans le magasin**, pas dans le jeton.
     *
     * Un rôle inscrit dans le jeton d'accès resterait valide un quart d'heure
     * après une rétrogradation. La session est déjà consultée à chaque requête ;
     * une lecture de plus est négligeable, et c'est ce qui fait qu'un retrait de
     * droits prend effet immédiatement.
     */
    app.decorate("requireAdmin", async (request: FastifyRequest) => {
      await app.requireUser(request);
      const { userId } = currentUser(request);

      const user = await options.services.users.findById(userId);
      if (user?.role !== "ADMIN") {
        throw new AuthorizationError({
          message: `Tableau de bord demandé par un compte non administrateur : ${userId}`,
          // Le message ne dit pas « il faut être administrateur » : la surface
          // d'administration n'a pas à s'annoncer à qui n'y a pas droit.
          userMessage: "La ressource demandée n'existe pas.",
          context: { userId },
        });
      }
    });

    app.decorate("requireDevice", async (request: FastifyRequest) => {
      const session = await options.services.deviceSessions.resolve(bearerToken(request));
      if (session === undefined) {
        // `resolve` retourne `undefined` aussi bien pour un jeton inconnu que
        // pour un appareil révoqué : la distinction n'aiderait qu'un attaquant.
        throw new AuthenticationError({
          message: "Session d'appareil invalide ou révoquée",
          userMessage: "Cet appareil n'est pas authentifié.",
        });
      }

      request.principal = {
        kind: "device",
        deviceId: session.deviceId,
        userId: session.userId,
        capabilities: [...session.capabilities],
      };
    });

    done();
  },
  { name: "nexus-authentication" },
);

/**
 * Utilisateur de la requête.
 *
 * @throws {AuthorizationError} si la requête n'a pas traversé `requireUser`.
 *   Lever plutôt que retourner `undefined` est délibéré : une route qui oublie
 *   sa garde doit échouer bruyamment, pas servir des données sans propriétaire.
 */
export function currentUser(request: FastifyRequest): { userId: string; sessionId: string } {
  const principal = request.principal;
  if (principal?.kind !== "user") {
    throw new AuthorizationError({
      message: "Route utilisateur atteinte sans principal utilisateur",
      userMessage: "Accès refusé.",
    });
  }
  return { userId: principal.userId, sessionId: principal.sessionId };
}

/** Appareil de la requête. Même règle que ci-dessus. */
export function currentDevice(request: FastifyRequest): {
  deviceId: string;
  userId: string;
  capabilities: string[];
} {
  const principal = request.principal;
  if (principal?.kind !== "device") {
    throw new AuthorizationError({
      message: "Route appareil atteinte sans principal appareil",
      userMessage: "Accès refusé.",
    });
  }
  return {
    deviceId: principal.deviceId,
    userId: principal.userId,
    capabilities: principal.capabilities,
  };
}

/**
 * Vérifie qu'une ressource appartient bien à l'utilisateur.
 *
 * Le contrôle d'accès le plus courant de cette API, et celui qu'on oublie : une
 * route qui charge une conversation par identifiant sans vérifier son
 * propriétaire laisse lire celles des autres à qui devine un identifiant.
 */
export function assertOwnedBy(resourceUserId: string, userId: string, what: string): void {
  if (resourceUserId === userId) return;

  throw new AuthorizationError({
    message: `${what} appartenant à un autre utilisateur`,
    // Le message ne distingue pas « n'existe pas » de « ne vous appartient
    // pas » : la différence permettrait de sonder l'existence des ressources.
    userMessage: "La ressource demandée n'existe pas.",
    context: { what },
  });
}
