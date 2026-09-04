import { z } from "zod";

/**
 * Contrats d'authentification — cf. docs/architecture/09-security-permissions.md §2.
 *
 * Ce paquet fixe les formes ; l'émission et la vérification des jetons arrivent
 * en phase 1, l'appairage d'appareil en phase 4.
 */

/** Claims d'un access token utilisateur (JWT court, EdDSA). */
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
 * Claims d'un appareil. Distincts des claims utilisateur : les surfaces
 * d'authentification sont séparées pour éviter toute confusion de privilèges.
 */
export const deviceTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  userId: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  capabilities: z.array(z.string()),
});

export type DeviceTokenClaims = z.infer<typeof deviceTokenClaimsSchema>;

export type Principal =
  | { kind: "user"; userId: string; sessionId: string }
  | { kind: "device"; deviceId: string; userId: string; capabilities: string[] };

export * from "./tokens.js";
export * from "./passwords.js";
