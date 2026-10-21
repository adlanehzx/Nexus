import { z } from "zod";
import { WorkerConfigurationError } from "./errors.js";
import { defaultStatePath } from "./runtime/state-file.js";
import { parseApplications } from "./capabilities/app.js";

/**
 * Configuration du worker.
 *
 * **Rien n'est codé en dur, et surtout pas l'identité de la machine.** Le même
 * binaire tourne sur le portable et sur le poste fixe ; ce qui les distingue
 * tient entièrement dans ces variables et dans ce que le backend a enregistré.
 * Chercher `if (hostname === ...)` dans ce dépôt ne donne rien — c'est voulu.
 *
 * Le rôle (`CLIENT`, `WORKER`, `BOTH`) n'apparaît pas ici : il appartient au
 * registre, côté cœur. Un worker qui déciderait lui-même de son rôle pourrait
 * se l'élargir.
 */

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/**
 * Liste séparée par des virgules.
 *
 * Le défaut est posé **avant** la transformation : en Zod 4, un `.default()`
 * placé après porterait sur le type de sortie, et il faudrait écrire un tableau
 * là où l'utilisateur écrit une chaîne.
 */
const csvList = (fallback = "") => z.string().default(fallback).transform(csv);

export const workerConfigSchema = z.object({
  /** Plateforme réellement annoncée au cœur. Le défaut préserve les installations Windows. */
  NEXUS_WORKER_PLATFORM: z.enum(["WINDOWS", "LINUX", "MACOS"]).default("WINDOWS"),

  /** URL du cœur. `wss://` en production — le worker refuse `ws://` distant. */
  NEXUS_BACKEND_URL: z.string().url(),

  /** Identifiant attribué par le backend à l'appairage. Public, il n'authentifie rien. */
  DEVICE_ID: z.string().min(1),

  /**
   * **Référence** vers la clé privée, jamais la clé elle-même.
   *
   * Un chemin de fichier. Une clé privée dans une variable d'environnement finit
   * dans l'historique du shell, dans les journaux de l'ordonnanceur, et dans les
   * rapports de plantage.
   */
  DEVICE_CREDENTIAL_PATH: z.string().min(1),

  /** Racines sous lesquelles la lecture et l'écriture sont permises. */
  WORKER_ALLOWED_PATHS: csvList(),

  /** Capacités exposées. Vide = toutes celles réellement disponibles localement. */
  WORKER_CAPABILITIES: csvList(),

  /** Exécutables autorisés pour `terminal.execute`. Vide = liste par défaut. */
  WORKER_ALLOWED_EXECUTABLES: csvList(),

  /** Variables d'environnement transmises aux processus lancés. */
  WORKER_ALLOWED_ENV: csvList(),

  /**
   * Applications ouvrables, sous la forme `nom=chemin`.
   *
   * C'est la frontière de `app.open` : la capacité n'accepte **jamais** de
   * chemin, seulement un nom présent dans cette table. Vide = `app.open` ne
   * peut rien ouvrir, ce qui est le bon défaut — une machine neuve n'a aucune
   * raison d'être pilotable avant qu'on l'ait dit.
   */
  WORKER_APPS: csvList(),

  /**
   * Empreinte SHA-256 (base64) de la clé publique du cœur.
   *
   * Vide = validation par les autorités du système seulement. La renseigner
   * ferme l'usurpation par une autorité de certification illégitime — proxy
   * d'entreprise, logiciel de sécurité, autorité compromise.
   */
  NEXUS_CORE_FINGERPRINT: z.string().default(""),

  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(20_000),
  WORKER_TASK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),

  /** Tâches menées de front. Au-delà, le worker refuse — le cœur choisit ailleurs. */
  WORKER_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(16).default(2),

  WORKER_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(1_000),
  WORKER_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(60_000),

  /**
   * Sous-commandes Docker autorisées. Volontairement restreint par défaut :
   * l'accès au démon Docker équivaut à un accès administrateur à la machine.
   */
  WORKER_DOCKER_ALLOWED: csvList("ps,images,logs,inspect"),

  /** Autorise les opérations Git qui écrivent (pull, checkout, commit, clone). */
  WORKER_GIT_ALLOW_WRITE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * Où déposer l'état **public** du démon.
   *
   * Vide = l'emplacement par défaut sous `%ProgramData%`. Ce fichier ne contient
   * qu'un identifiant d'appareil ; il permet à l'interface installée sur la même
   * machine de se reconnaître, et n'ouvre aucun droit.
   */
  WORKER_STATE_PATH: z.string().default(""),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type WorkerConfigInput = z.input<typeof workerConfigSchema>;
export type RawWorkerConfig = z.infer<typeof workerConfigSchema>;

/** Configuration résolue, telle que le reste du worker la consomme. */
export interface WorkerConfig {
  /** Facultatif dans les ports de test historiques ; le chargeur le résout toujours. */
  platform?: "WINDOWS" | "LINUX" | "MACOS";
  backendUrl: string;
  deviceId: string;
  credentialPath: string;
  allowedPaths: string[];
  declaredCapabilities: string[];
  allowedExecutables: string[];
  allowedEnv: string[];
  /** Table `nom logique → exécutable` pour `app.open`. */
  applications: Map<string, string>;
  /** Empreinte épinglée du cœur, ou `undefined`. */
  coreFingerprint: string | undefined;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  dockerAllowed: string[];
  gitAllowWrite: boolean;
  statePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Valide et normalise la configuration.
 *
 * @throws {WorkerConfigurationError} sur toute variable manquante ou aberrante.
 *   Le worker refuse de démarrer plutôt que de tourner à moitié configuré : un
 *   worker sans `WORKER_ALLOWED_PATHS` n'a pas « pas de restriction », il a une
 *   configuration incomplète.
 */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = workerConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} : ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const issues: string[] = [];

  // Une URL distante en clair transporterait le jeton de session en clair.
  const url = new URL(raw.NEXUS_BACKEND_URL);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocal && (url.protocol === "ws:" || url.protocol === "http:")) {
    issues.push("NEXUS_BACKEND_URL : une adresse distante doit utiliser wss:// ou https://");
  }

  if (raw.WORKER_RECONNECT_MAX_MS <= raw.WORKER_RECONNECT_MIN_MS) {
    issues.push("WORKER_RECONNECT_MAX_MS doit dépasser WORKER_RECONNECT_MIN_MS");
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    platform: raw.NEXUS_WORKER_PLATFORM,
    backendUrl: raw.NEXUS_BACKEND_URL,
    deviceId: raw.DEVICE_ID,
    credentialPath: raw.DEVICE_CREDENTIAL_PATH,
    allowedPaths: raw.WORKER_ALLOWED_PATHS,
    declaredCapabilities: raw.WORKER_CAPABILITIES,
    allowedExecutables: raw.WORKER_ALLOWED_EXECUTABLES,
    allowedEnv: raw.WORKER_ALLOWED_ENV,
    applications: parseApplications(raw.WORKER_APPS),
    coreFingerprint: raw.NEXUS_CORE_FINGERPRINT === "" ? undefined : raw.NEXUS_CORE_FINGERPRINT,
    heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
    taskTimeoutMs: raw.WORKER_TASK_TIMEOUT_MS,
    maxConcurrentTasks: raw.WORKER_MAX_CONCURRENT_TASKS,
    reconnectMinMs: raw.WORKER_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.WORKER_RECONNECT_MAX_MS,
    dockerAllowed: raw.WORKER_DOCKER_ALLOWED,
    gitAllowWrite: raw.WORKER_GIT_ALLOW_WRITE,
    statePath: raw.WORKER_STATE_PATH === "" ? defaultStatePath(env) : raw.WORKER_STATE_PATH,
    logLevel: raw.LOG_LEVEL,
  };
}
