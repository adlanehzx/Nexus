import { z } from "zod";
import { WorkerConfigurationError } from "@nexus/worker-core";

/**
 * Configuration du worker Android.
 *
 * **Rien n'est codé en dur, et surtout pas l'identité de l'appareil.** Chercher
 * « Redmi » dans ce dépôt ne donne rien : le téléphone est une ligne en base,
 * de type `ANDROID` et de rôle `WORKER`. Remplacer le Redmi par un autre
 * téléphone est un réappairage, pas une modification du code.
 *
 * Le rôle n'apparaît pas ici : il appartient au registre, côté cœur. Un worker
 * qui déciderait lui-même de son rôle pourrait se l'élargir — et celui-ci n'est
 * pas un client NEXUS, il n'a pas à recevoir les événements de l'utilisateur.
 */

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const csvList = (fallback = "") => z.string().default(fallback).transform(csv);

export const androidConfigSchema = z.object({
  /** Cœur NEXUS. Une adresse distante doit être en `wss://`. */
  NEXUS_BACKEND_URL: z.string().url(),

  /** Attribué par le backend à l'appairage. Public : il n'authentifie rien. */
  DEVICE_ID: z.string().min(1),

  /**
   * Alias de la clé dans le magasin de clés d'Android.
   *
   * Une **référence**, jamais la clé. Le secret ne quitte pas le magasin, et
   * l'application elle-même ne le lit jamais : elle demande une signature.
   */
  DEVICE_KEY_ALIAS: z.string().min(1).default("nexus.device.key"),

  /** Capacités exposées. Vide = toutes celles réellement disponibles. */
  WORKER_CAPABILITIES: csvList(),

  /**
   * Applications ouvrables. Vide = toutes sauf celles refusées par la politique.
   *
   * Une liste explicite est le réglage recommandé sur un téléphone personnel.
   */
  ANDROID_ALLOWED_PACKAGES: csvList(),
  ANDROID_DENIED_PACKAGES: csvList(),

  /**
   * Autorise les clics par coordonnées.
   *
   * Faux par défaut : cliquer en (540, 1200) touche ce qui s'y trouve, pas ce
   * qu'on visait.
   */
  ANDROID_ALLOW_COORDINATE_CLICKS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  ANDROID_SCREENSHOT_MAX_DIMENSION: z.coerce.number().int().min(240).max(2_048).default(1_280),
  /** Intervalle minimal entre deux captures — barrière contre l'enregistrement continu. */
  ANDROID_SCREENSHOT_MIN_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(1_000),

  /** Sous ce niveau et sans charge, l'appareil se déclare dégradé. */
  ANDROID_LOW_BATTERY_PERCENT: z.coerce.number().int().min(0).max(100).default(20),
  /** Sous ce niveau, il refuse toute nouvelle tâche. */
  ANDROID_CRITICAL_BATTERY_PERCENT: z.coerce.number().int().min(0).max(100).default(10),

  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  WORKER_TASK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Un téléphone ne mène pas trois automatisations d'interface de front. */
  WORKER_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(4).default(1),

  WORKER_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(2_000),
  WORKER_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(120_000),

  /** Période de vérification de la disponibilité des capacités. */
  ANDROID_AVAILABILITY_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AndroidWorkerConfig {
  backendUrl: string;
  deviceId: string;
  keyAlias: string;
  declaredCapabilities: string[];
  allowedPackages: string[];
  deniedPackages: string[];
  allowCoordinateClicks: boolean;
  screenshotMaxDimension: number;
  screenshotMinIntervalMs: number;
  lowBatteryPercent: number;
  criticalBatteryPercent: number;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  availabilityIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Valide et normalise la configuration.
 *
 * @throws {WorkerConfigurationError} sur toute variable manquante ou aberrante.
 *   Le worker refuse de démarrer plutôt que de tourner à moitié configuré.
 */
export function loadAndroidConfig(env: Record<string, string | undefined>): AndroidWorkerConfig {
  const parsed = androidConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} : ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const issues: string[] = [];

  // Un téléphone se connecte depuis n'importe quel réseau — un point d'accès
  // public, un partage de connexion. Le jeton de session ne peut pas transiter
  // en clair.
  const url = new URL(raw.NEXUS_BACKEND_URL);
  const isLocal =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "10.0.2.2";
  if (!isLocal && (url.protocol === "ws:" || url.protocol === "http:")) {
    issues.push("NEXUS_BACKEND_URL : une adresse distante doit utiliser wss:// ou https://");
  }

  if (raw.WORKER_RECONNECT_MAX_MS <= raw.WORKER_RECONNECT_MIN_MS) {
    issues.push("WORKER_RECONNECT_MAX_MS doit dépasser WORKER_RECONNECT_MIN_MS");
  }

  if (raw.ANDROID_CRITICAL_BATTERY_PERCENT > raw.ANDROID_LOW_BATTERY_PERCENT) {
    issues.push(
      "ANDROID_CRITICAL_BATTERY_PERCENT doit être inférieur ou égal à ANDROID_LOW_BATTERY_PERCENT",
    );
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    backendUrl: raw.NEXUS_BACKEND_URL,
    deviceId: raw.DEVICE_ID,
    keyAlias: raw.DEVICE_KEY_ALIAS,
    declaredCapabilities: raw.WORKER_CAPABILITIES,
    allowedPackages: raw.ANDROID_ALLOWED_PACKAGES,
    deniedPackages: raw.ANDROID_DENIED_PACKAGES,
    allowCoordinateClicks: raw.ANDROID_ALLOW_COORDINATE_CLICKS,
    screenshotMaxDimension: raw.ANDROID_SCREENSHOT_MAX_DIMENSION,
    screenshotMinIntervalMs: raw.ANDROID_SCREENSHOT_MIN_INTERVAL_MS,
    lowBatteryPercent: raw.ANDROID_LOW_BATTERY_PERCENT,
    criticalBatteryPercent: raw.ANDROID_CRITICAL_BATTERY_PERCENT,
    heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
    taskTimeoutMs: raw.WORKER_TASK_TIMEOUT_MS,
    maxConcurrentTasks: raw.WORKER_MAX_CONCURRENT_TASKS,
    reconnectMinMs: raw.WORKER_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.WORKER_RECONNECT_MAX_MS,
    availabilityIntervalMs: raw.ANDROID_AVAILABILITY_INTERVAL_MS,
    logLevel: raw.LOG_LEVEL,
  };
}
