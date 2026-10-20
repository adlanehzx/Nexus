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
    /**
     * Exige une **assertion de mission** signée.
     *
     * Troisième surface, pour les services internes — Mission Engine
     * aujourd'hui. Elle n'authentifie pas un porteur mais une délégation : le
     * principal obtenu porte un utilisateur *et* la mission dans laquelle il
     * est permis d'agir. Une route gardée par celle-ci ne doit jamais accepter
     * une ressource hors de cette portée, et `assertMissionScope` est là pour
     * l'exiger explicitement.
     */
    requireMissionGrant: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Services autorisés à présenter une assertion de mission.
 *
 * Liste blanche, et non simple vérification de signature : la clé qui signe les
 * assertions signe aussi les jetons d'accès. Nommer le service attendu ferme la
 * porte à une assertion émise pour un autre usage interne, présente ou futur.
 */
const ALLOWED_GRANT_SERVICES = new Set(["mission-engine"]);

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

    /**
     * Aucune session n'est consultée ici, et c'est délibéré.
     *
     * Une assertion de mission ne représente pas une connexion : elle
     * représente un travail en cours. La subordonner à une session active
     * casserait la promesse de durabilité du moteur — une mission lancée le
     * soir doit pouvoir se terminer après la déconnexion de son propriétaire.
     * Ce qui la borne n'est donc pas la session mais sa portée et son
     * expiration, toutes deux inscrites dans la signature.
     */
    app.decorate("requireMissionGrant", async (request: FastifyRequest) => {
      const claims = options.services.tokens.verifyMissionGrant(bearerToken(request));

      if (!ALLOWED_GRANT_SERVICES.has(claims.svc)) {
        throw new AuthorizationError({
          message: `Assertion de mission présentée par un service inconnu : ${claims.svc}`,
          userMessage: "Accès refusé.",
          context: { service: claims.svc },
        });
      }

      // Le propriétaire a pu être supprimé ou suspendu depuis l'émission. Une
      // mission ne doit pas continuer d'agir pour un compte qui n'existe plus.
      const owner = await options.services.users.findById(claims.sub);
      if (owner?.status !== "ACTIVE") {
        throw new AuthorizationError({
          message: `Assertion de mission pour un compte inactif : ${claims.sub}`,
          userMessage: "Accès refusé.",
          context: { userId: claims.sub },
        });
      }

      request.principal = {
        kind: "mission",
        userId: claims.sub,
        service: claims.svc,
        missionExternalKey: claims.mek,
        grantId: claims.jti,
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
 * Mission de la requête. Même règle que ci-dessus : une route gardée par
 * `requireMissionGrant` qui oublierait d'appeler ceci doit échouer, pas servir.
 */
export function currentMission(request: FastifyRequest): {
  userId: string;
  service: string;
  missionExternalKey: string;
  grantId: string;
} {
  const principal = request.principal;
  if (principal?.kind !== "mission") {
    throw new AuthorizationError({
      message: "Route de mission atteinte sans principal de mission",
      userMessage: "Accès refusé.",
    });
  }
  return {
    userId: principal.userId,
    service: principal.service,
    missionExternalKey: principal.missionExternalKey,
    grantId: principal.grantId,
  };
}

/**
 * Vérifie qu'une requête reste dans la mission que l'assertion lui ouvre.
 *
 * C'est le pendant de `assertOwnedBy` pour la surface de délégation, et il est
 * tout aussi facile à oublier. Sans lui, une assertion valide pour une mission
 * pourrait piloter le travail d'une autre mission du même utilisateur — la
 * signature prouverait le propriétaire, mais plus la portée, et toute la raison
 * d'être de l'assertion disparaîtrait.
 */
export function assertMissionScope(
  grantedExternalKey: string,
  requestedExternalKey: string,
): void {
  if (grantedExternalKey === requestedExternalKey) return;

  throw new AuthorizationError({
    message: "Assertion de mission utilisée hors de sa portée",
    userMessage: "La ressource demandée n'existe pas.",
    context: { granted: grantedExternalKey, requested: requestedExternalKey },
  });
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
