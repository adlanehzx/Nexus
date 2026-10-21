import { z } from "zod";

/**
 * Authentication contracts — cf. docs/architecture/09-security-permissions.md §2.
 */

/** User access token claims (short-lived JWT, EdDSA). */
export const accessTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string().min(1),
  aud: z.string().min(1),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/**
 * Device token claims. Distinct from user claims: authentication surfaces
 * are separated to prevent privilege confusion.
 */
export const deviceTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  userId: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  capabilities: z.array(z.string()),
});

export type DeviceTokenClaims = z.infer<typeof deviceTokenClaimsSchema>;

/**
 * Mission grant claims — signed ownership assertion presented by Mission Engine
 * to act on behalf of a user.
 *
 * Distinct from user and device tokens: it designates a scoped delegation
 * (service, owner, and specific mission key) rather than a global identity.
 */
export const missionGrantClaimsSchema = z.object({
  /** Mission owner. */
  sub: z.string().min(1),
  /** Service authorized to present the assertion. */
  svc: z.string().min(1),
  /** External mission key: scope delimiter. */
  mek: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string().min(1),
  aud: z.string().min(1),
  /** Unique ID to log replays without logging the token itself. */
  jti: z.string().min(1),
});

export type MissionGrantClaims = z.infer<typeof missionGrantClaimsSchema>;

/**
 * Service token claims, issued by API to interact with internal services.
 * Short-lived (typically ~2 minutes) and bound to a specific audience.
 */
export const serviceTokenClaimsSchema = z.object({
  /** Issuer service. */
  sub: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string().min(1),
  /** Target service. */
  aud: z.string().min(1),
  jti: z.string().min(1),
});

export type ServiceTokenClaims = z.infer<typeof serviceTokenClaimsSchema>;

export type Principal =
  | { kind: "user"; userId: string; sessionId: string }
  | { kind: "device"; deviceId: string; userId: string; capabilities: string[] }
  | {
      kind: "mission";
      userId: string;
      service: string;
      missionExternalKey: string;
      grantId: string;
    };

export * from "./tokens.js";
export * from "./passwords.js";
