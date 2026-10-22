import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { AuthenticationError, AuthorizationError } from "@nexus/shared";
import type { Principal } from "@nexus/auth";
import type { ServiceContainer } from "../services/container.js";

/**
 * HTTP request authentication.
 *
 * **Two strictly separated surfaces.** A device token never grants user rights,
 * and vice versa. The separation is carried by the tokens themselves — their claims differ,
 * and `verifyAccessToken` rejects a device token — but it is also made explicit here:
 * routes declare which one they expect, and there is no generic guard that accepts both implicitly.
 *
 * Verification occurs in two steps:
 *
 *  1. The **signature** proves the token originated from us;
 *  2. The **session** proves it is still valid.
 *
 * The second step is not redundant. An access token remains cryptographically valid
 * until expiration; without consulting the session, a sign-out would only take effect
 * fifteen minutes later.
 */

declare module "fastify" {
  interface FastifyInstance {
    services: ServiceContainer;
    /** Requires an authenticated user. */
    requireUser: (request: FastifyRequest) => Promise<void>;
    /** Requires an authenticated device. Distinct surface from the former. */
    requireDevice: (request: FastifyRequest) => Promise<void>;
    /**
     * Requires an **administrator** user.
     *
     * Guard for the supervision dashboard, which provides a whole-system view.
     * An ordinary client token must not unlock it: a lost phone would then expose
     * the entire infrastructure in addition to the conversation.
     */
    requireAdmin: (request: FastifyRequest) => Promise<void>;
    /**
     * Requires a signed **mission grant**.
     *
     * Third surface, for internal services — Mission Engine today.
     * It does not authenticate a bearer but a delegation: the resulting principal
     * carries a user *and* the mission in which acting is permitted. A route
     * guarded by this must never accept a resource outside that scope, and
     * `assertMissionScope` explicitly enforces this.
     */
    requireMissionGrant: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Services authorized to present a mission grant.
 *
 * Whitelist, not a simple signature check: the key that signs mission grants
 * also signs access tokens. Naming the expected service closes the door to a
 * grant issued for another internal use, present or future.
 */
const ALLOWED_GRANT_SERVICES = new Set(["mission-engine"]);

export interface AuthenticationPluginOptions {
  services: ServiceContainer;
}

/** Extracts the bearer token, without disclosing why it was rejected. */
function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new AuthenticationError({
      message: "Authorization header missing or malformed",
      userMessage: "Authentication required.",
    });
  }

  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    throw new AuthenticationError({ message: "Empty bearer token" });
  }
  return token;
}

export const authenticationPlugin = fp<AuthenticationPluginOptions>(
  (app, options, done) => {
    app.decorate("services", options.services);
    app.decorateRequest("principal", undefined);

    app.decorate("requireUser", async (request: FastifyRequest) => {
      const claims = options.services.tokens.verifyAccessToken(bearerToken(request));

      // The session may have been closed since token issuance. Without this
      // check, logging out would do nothing for fifteen minutes.
      await options.services.auth.assertSessionActive(claims.sid);

      request.principal = { kind: "user", userId: claims.sub, sessionId: claims.sid };
    });

    /**
     * The role is read **from the store**, not from the token.
     *
     * A role baked into the access token would remain valid for fifteen minutes
     * after a demotion. The session is already consulted on every request; one
     * extra read is negligible, and ensures permission revocations take effect immediately.
     */
    app.decorate("requireAdmin", async (request: FastifyRequest) => {
      await app.requireUser(request);
      const { userId } = currentUser(request);

      const user = await options.services.users.findById(userId);
      if (user?.role !== "ADMIN") {
        throw new AuthorizationError({
          message: `Dashboard requested by non-administrator account: ${userId}`,
          // The message does not say "must be admin": the administration surface
          // does not need to advertise itself to unauthorized callers.
          userMessage: "The requested resource does not exist.",
          context: { userId },
        });
      }
    });

    app.decorate("requireDevice", async (request: FastifyRequest) => {
      const session = await options.services.deviceSessions.resolve(bearerToken(request));
      if (session === undefined) {
        // `resolve` returns `undefined` both for an unknown token and for a
        // revoked device: the distinction would only aid an attacker.
        throw new AuthenticationError({
          message: "Invalid or revoked device session",
          userMessage: "This device is not authenticated.",
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
     * No session is consulted here, and this is deliberate.
     *
     * A mission grant does not represent a connection: it represents work in progress.
     * Subordinating it to an active session would break the engine's durability
     * promise — a mission started in the evening must be able to complete after
     * its owner disconnects. What bounds it is not the session but its scope and
     * expiration, both embedded in the signature.
     */
    app.decorate("requireMissionGrant", async (request: FastifyRequest) => {
      const claims = options.services.tokens.verifyMissionGrant(bearerToken(request));

      if (!ALLOWED_GRANT_SERVICES.has(claims.svc)) {
        throw new AuthorizationError({
          message: `Mission grant presented by unknown service: ${claims.svc}`,
          userMessage: "Access denied.",
          context: { service: claims.svc },
        });
      }

      // The owner may have been deleted or suspended since issuance. A mission
      // must not continue acting on behalf of an account that no longer exists.
      const owner = await options.services.users.findById(claims.sub);
      if (owner?.status !== "ACTIVE") {
        throw new AuthorizationError({
          message: `Mission grant for inactive account: ${claims.sub}`,
          userMessage: "Access denied.",
          context: { userId: claims.sub },
        });
      }

      // Valid signature is not enough: the registry verifies whether the grant
      // is still usable. This allows revoking a compromised grant before its
      // expiration instead of leaving it open for twenty-four hours.
      await options.services.missionGrants.assertUsable(claims);

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
 * Request user.
 *
 * @throws {AuthorizationError} if the request did not pass through `requireUser`.
 *   Throwing rather than returning `undefined` is deliberate: a route that forgets
 *   its guard must fail loudly, not serve unowned data.
 */
export function currentUser(request: FastifyRequest): { userId: string; sessionId: string } {
  const principal = request.principal;
  if (principal?.kind !== "user") {
    throw new AuthorizationError({
      message: "User route reached without user principal",
      userMessage: "Access denied.",
    });
  }
  return { userId: principal.userId, sessionId: principal.sessionId };
}

/** Request device. Same rule as above. */
export function currentDevice(request: FastifyRequest): {
  deviceId: string;
  userId: string;
  capabilities: string[];
} {
  const principal = request.principal;
  if (principal?.kind !== "device") {
    throw new AuthorizationError({
      message: "Device route reached without device principal",
      userMessage: "Access denied.",
    });
  }
  return {
    deviceId: principal.deviceId,
    userId: principal.userId,
    capabilities: principal.capabilities,
  };
}

/**
 * Request mission. Same rule as above: a route guarded by `requireMissionGrant`
 * that forgets to call this must fail, not serve.
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
      message: "Mission route reached without mission principal",
      userMessage: "Access denied.",
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
 * Verifies that a request stays within the mission permitted by the grant.
 *
 * This is the delegation counterpart of `assertOwnedBy`, and just as easy to forget.
 * Without it, a valid grant for one mission could control the work of another mission
 * belonging to the same user — the signature would prove ownership, but not scope,
 * and the entire purpose of the grant would disappear.
 */
export function assertMissionScope(grantedExternalKey: string, requestedExternalKey: string): void {
  if (grantedExternalKey === requestedExternalKey) return;

  throw new AuthorizationError({
    message: "Mission grant used outside its scope",
    userMessage: "The requested resource does not exist.",
    context: { granted: grantedExternalKey, requested: requestedExternalKey },
  });
}

/**
 * Verifies that a resource belongs to the user.
 *
 * The most common access control in this API, and the easiest to overlook: a route
 * that loads a conversation by ID without checking ownership allows anyone guessing an ID
 * to read other users' conversations.
 */
export function assertOwnedBy(resourceUserId: string, userId: string, what: string): void {
  if (resourceUserId === userId) return;

  throw new AuthorizationError({
    message: `${what} belonging to another user`,
    // The message does not distinguish between "does not exist" and "does not
    // belong to you": the difference would allow probing for resource existence.
    userMessage: "The requested resource does not exist.",
    context: { what },
  });
}
