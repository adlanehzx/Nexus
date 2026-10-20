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

/**
 * Claims d'une **assertion de mission** — l'identité propriétaire signée que
 * Mission Engine présente pour agir au nom d'un utilisateur.
 *
 * Troisième surface, délibérément distincte des deux précédentes. Elle ne
 * désigne pas un porteur mais une **portée** : un service, un propriétaire et
 * une mission précise. La vérification ne demande donc jamais « qui es-tu ? »
 * mais « cette mission-là t'a-t-elle été confiée par cet utilisateur-là ? ».
 * Une assertion volée ne donne pas les droits du compte : elle donne le droit
 * d'agir dans une mission, et elle expire.
 */
export const missionGrantClaimsSchema = z.object({
  /** Propriétaire de la mission. */
  sub: z.string().min(1),
  /** Service autorisé à présenter l'assertion. */
  svc: z.string().min(1),
  /** Clé externe de la mission : la portée, et rien de plus. */
  mek: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string().min(1),
  aud: z.string().min(1),
  /** Identifiant unique, pour journaliser un rejeu sans journaliser le jeton. */
  jti: z.string().min(1),
});

export type MissionGrantClaims = z.infer<typeof missionGrantClaimsSchema>;

/**
 * Claims d'un **jeton de service**, émis par l'API pour s'adresser à un autre
 * service de NEXUS.
 *
 * Quatrième surface, et la plus courte : un jeton de service ne désigne ni
 * utilisateur, ni appareil, ni mission. Il dit seulement « cet appel vient de
 * l'API », et c'est tout ce dont le destinataire a besoin pour savoir qu'il ne
 * parle pas à un processus local quelconque.
 *
 * Sa durée de vie est de l'ordre de la minute : il est émis par appel, et ce
 * qui le borne est son expiration, pas un registre. Aucun état à tenir pour
 * une identité qui ne survit pas à la requête.
 */
export const serviceTokenClaimsSchema = z.object({
  /** Service émetteur. */
  sub: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string().min(1),
  /** Service destinataire. */
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
