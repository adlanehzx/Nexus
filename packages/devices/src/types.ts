import { z } from "zod";

/**
 * Modèle d'appareil.
 *
 * Un principe gouverne ce fichier : **le cœur ne connaît aucun appareil par son
 * nom**. Il ne connaît que des rôles, des types et des capacités. « L'iPhone
 * d'Alex » n'existe nulle part dans le code — il existe une ligne en base dont
 * le rôle est `CLIENT` et le type `IPHONE`. Ajouter un appareil est une écriture
 * en base, jamais un `if`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Rôles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce qu'un appareil a le droit d'être.
 *
 * `BOTH` n'est pas une commodité : le portable Windows est réellement les deux à
 * la fois — on y discute avec NEXUS, et il exécute des tâches. Le distinguer d'un
 * `WORKER` importe, parce qu'un client ne doit jamais être sélectionné comme
 * exécutant s'il n'a pas explicitement ce rôle.
 */
export const deviceRoleSchema = z.enum(["CLIENT", "WORKER", "BOTH"]);
export type DeviceRole = z.infer<typeof deviceRoleSchema>;

export function canAcceptTasks(role: DeviceRole): boolean {
  return role === "WORKER" || role === "BOTH";
}

export function canReceiveEvents(role: DeviceRole): boolean {
  return role === "CLIENT" || role === "BOTH";
}

// ─────────────────────────────────────────────────────────────────────────────
// Types et plateformes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nature de l'appareil.
 *
 * `BROWSER_WORKER` y figure parce que Browser Use est un exécutant à part
 * entière du point de vue du sélecteur — il a des capacités, un état de santé,
 * une disponibilité — tout en n'étant pas un appareil physique. Le distinguer
 * évite qu'il apparaisse dans une liste d'appareils de l'utilisateur.
 */
export const deviceTypeSchema = z.enum([
  "IPHONE",
  "ANDROID",
  "WINDOWS_PC",
  "MAC",
  "LINUX",
  "BROWSER_WORKER",
]);
export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const devicePlatformSchema = z.enum(["WINDOWS", "MACOS", "LINUX", "IOS", "ANDROID", "WEB"]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/** Un appareil physique appartient à un humain ; un worker de service, non. */
export function isPhysicalDevice(type: DeviceType): boolean {
  return type !== "BROWSER_WORKER";
}

// ─────────────────────────────────────────────────────────────────────────────
// État
// ─────────────────────────────────────────────────────────────────────────────

export const deviceStatusSchema = z.enum(["ONLINE", "OFFLINE", "DEGRADED", "REVOKED"]);
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

/**
 * Confiance accordée à l'appareil.
 *
 * Distincte du statut : un appareil peut être en ligne et non fiable. Un
 * appareil fraîchement appairé est `PENDING` — il ne reçoit aucune tâche tant
 * qu'un humain ne l'a pas approuvé.
 */
export const trustStateSchema = z.enum(["PENDING", "TRUSTED", "REVOKED"]);
export type TrustState = z.infer<typeof trustStateSchema>;

export const deviceHealthSchema = z.object({
  /** Charge processeur observée, de 0 à 1. */
  cpuLoad: z.number().min(0).max(1).optional(),
  memoryFreeMb: z.number().nonnegative().optional(),
  diskFreeMb: z.number().nonnegative().optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
  /** Sur batterie : un worker sur secteur est préférable pour une tâche longue. */
  onBattery: z.boolean().optional(),
  /** Aller-retour mesuré au dernier battement de cœur. */
  latencyMs: z.number().nonnegative().optional(),
  /** Tâches en cours sur cet appareil. */
  activeTasks: z.number().int().nonnegative().default(0),
  /** Au-delà, l'appareil refuse de nouvelles tâches. */
  maxConcurrentTasks: z.number().int().positive().default(1),
  reportedAt: z.string().optional(),
});
export type DeviceHealth = z.infer<typeof deviceHealthSchema>;

export const DEFAULT_HEALTH: DeviceHealth = { activeTasks: 0, maxConcurrentTasks: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// Capacités
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capacité déclarée par un appareil.
 *
 * Le nom partage l'espace des permissions (`domaine.action`) : c'est
 * intentionnel. Une **capacité** dit ce qu'un appareil sait faire, une
 * **permission** dit ce que l'utilisateur autorise. Les deux doivent être
 * réunies pour qu'une action ait lieu, et les nommer pareil rend la relation
 * lisible dans les journaux comme dans l'interface.
 */
export const deviceCapabilitySchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/, "forme attendue : domaine.action"),
  version: z.string().default("1"),
  /** Description destinée au modèle quand la capacité devient un outil. */
  description: z.string().default(""),
  /** Schéma JSON des arguments, tel que le worker le déclare. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  /** Le worker peut refuser une capacité sans se désenregistrer entièrement. */
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Identifiants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Secret d'authentification d'un appareil.
 *
 * On ne stocke jamais la valeur : une clé publique Ed25519 pour les appareils
 * appairés, ou l'empreinte d'un jeton pour les workers de service. `rotatedAt`
 * et `expiresAt` rendent la rotation observable.
 */
export const deviceCredentialSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  /**
   * `ECDSA_P256_PUBLIC_KEY` existe parce que le magasin de clés d'Android ne
   * gère pas Ed25519 : c'est la seule courbe qui permette une clé d'appareil
   * non extractible sur un téléphone.
   */
  kind: z.enum(["ED25519_PUBLIC_KEY", "ECDSA_P256_PUBLIC_KEY", "SERVICE_TOKEN_HASH"]),
  /** Clé publique, ou empreinte du jeton. Jamais un secret en clair. */
  material: z.string().min(1),
  createdAt: z.date(),
  rotatedAt: z.date().nullable().default(null),
  expiresAt: z.date().nullable().default(null),
  revokedAt: z.date().nullable().default(null),
});
export type DeviceCredential = z.infer<typeof deviceCredentialSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Appareil
// ─────────────────────────────────────────────────────────────────────────────

export const deviceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  type: deviceTypeSchema,
  platform: devicePlatformSchema,
  role: deviceRoleSchema,
  status: deviceStatusSchema,
  trust: trustStateSchema,
  capabilities: z.array(deviceCapabilitySchema).default([]),
  health: deviceHealthSchema.default(DEFAULT_HEALTH),
  /**
   * Permissions accordées **à cet appareil**, en plus de celles de
   * l'utilisateur. Un même utilisateur peut autoriser `terminal.execute` sur son
   * poste fixe et le refuser sur son portable.
   */
  grantedPermissions: z.array(z.string()).default([]),
  agentVersion: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.string()).default({}),
  lastSeenAt: z.date().nullable().default(null),
  pairedAt: z.date(),
  revokedAt: z.date().nullable().default(null),
  /** Vrai tant qu'une session authentifiée est ouverte. */
  authenticated: z.boolean().default(false),
});
export type Device = z.infer<typeof deviceSchema>;

/** Ce qu'il faut pour enregistrer un appareil ; le reste a des valeurs par défaut. */
export interface RegisterDeviceInput {
  id?: string;
  userId: string;
  name: string;
  type: DeviceType;
  platform: DevicePlatform;
  role: DeviceRole;
  capabilities?: DeviceCapability[];
  grantedPermissions?: string[];
  metadata?: Record<string, string>;
  agentVersion?: string;
  /** Un appareil arrive `PENDING` : la confiance se donne, elle ne se suppose pas. */
  trust?: TrustState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session d'appareil
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session authentifiée d'un appareil connecté.
 *
 * Un identifiant d'appareil ne suffit jamais à s'authentifier : il est public,
 * il apparaît dans les journaux et dans l'interface. Une session naît d'un
 * challenge signé et porte un jeton à durée limitée, rotatif.
 */
export const deviceSessionSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  userId: z.string().min(1),
  /** Empreinte du jeton de session. La valeur n'est rendue qu'une fois. */
  tokenHash: z.string().min(1),
  issuedAt: z.date(),
  expiresAt: z.date(),
  lastHeartbeatAt: z.date(),
  rotatedFromId: z.string().nullable().default(null),
  revokedAt: z.date().nullable().default(null),
  /** Capacités négociées à l'ouverture — bornées par celles de l'appareil. */
  capabilities: z.array(z.string()).default([]),
  remoteAddress: z.string().nullable().default(null),
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export function isSessionActive(session: DeviceSession, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

/** Un appareil utilisable maintenant : en ligne, de confiance, authentifié. */
export function isOperational(device: Device): boolean {
  return (
    device.status === "ONLINE" &&
    device.trust === "TRUSTED" &&
    device.revokedAt === null &&
    device.authenticated
  );
}
