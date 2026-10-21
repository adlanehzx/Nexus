import { missingCapabilities, permissionForCapability } from "./capabilities.js";
import { NoEligibleWorkerError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import { canAcceptTasks, isOperational, type Device } from "./types.js";

/**
 * Sélection de l'exécutant.
 *
 * La règle qui gouverne ce fichier : **jamais de nom d'appareil dans le code**.
 * Pas de « si la tâche parle de Docker, prendre le poste fixe ». Le chemin est
 * toujours le même :
 *
 *     capacités requises → workers compatibles → filtres durs → score → choix
 *
 * Les filtres durs sont des questions de sécurité et ne se négocient pas. Le
 * score, lui, n'est qu'une préférence : entre deux workers également légitimes,
 * il choisit le plus disponible.
 */

export interface SelectionRequest {
  userId: string;
  requiredCapabilities: readonly string[];
  /** Permissions accordées à l'utilisateur, en plus de celles de l'appareil. */
  userPermissions?: readonly string[];
  /** Choix explicite de l'utilisateur — respecté s'il reste éligible. */
  preferredDeviceId?: string;
  /** Appareils écartés, par exemple après un échec sur l'un d'eux. */
  excludeDeviceIds?: readonly string[];
  /** Contraintes de la tâche : type ou plateforme imposés. */
  constraints?: {
    // `| undefined` explicite : sous `exactOptionalPropertyTypes`, une contrainte
    // venue d'un schéma Zod arrive avec cette forme.
    deviceTypes?: readonly Device["type"][] | undefined;
    platforms?: readonly Device["platform"][] | undefined;
    /** Refuse un appareil sur batterie — utile pour une tâche longue. */
    requireMainsPower?: boolean | undefined;
  };
}

export interface ScoredCandidate {
  device: Device;
  score: number;
  reasons: string[];
}

export interface SelectionResult {
  device: Device;
  score: number;
  /** Candidats évalués, du meilleur au moins bon — diagnostic et repli. */
  candidates: ScoredCandidate[];
  /** Pourquoi chaque appareil écarté l'a été. */
  rejected: { deviceId: string; name: string; reason: string }[];
}

export interface DeviceSelectorOptions {
  registry: DeviceRegistry;
  /** Poids du score. Ajustables sans toucher à la logique. */
  weights?: Partial<typeof DEFAULT_WEIGHTS>;
}

const DEFAULT_WEIGHTS = {
  /** Un choix explicite de l'utilisateur domine tout le reste. */
  preference: 1_000,
  /** Un worker sans tâche en cours passe devant un worker occupé. */
  availability: 300,
  /** Charge processeur et mémoire. */
  health: 200,
  /** Latence mesurée au dernier battement de cœur. */
  latency: 150,
  /** Sur secteur plutôt que sur batterie. */
  mainsPower: 100,
  /** Capacités superflues : un worker spécialisé est préféré à un généraliste. */
  specialization: 50,
};

export class DeviceSelector {
  readonly #registry: DeviceRegistry;
  readonly #weights: typeof DEFAULT_WEIGHTS;

  constructor(options: DeviceSelectorOptions) {
    this.#registry = options.registry;
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  }

  /**
   * Choisit le meilleur worker, ou lève en expliquant pourquoi aucun ne convient.
   *
   * @throws {NoEligibleWorkerError} avec le détail de chaque rejet — c'est ce
   *   message que l'agent relaie à l'utilisateur.
   */
  async select(request: SelectionRequest): Promise<SelectionResult> {
    const result = await this.trySelect(request);
    if (result === undefined) {
      const rejected = await this.#explain(request);
      throw new NoEligibleWorkerError(
        request.requiredCapabilities,
        rejected.map((r) => `${r.name} : ${r.reason}`),
      );
    }
    return result;
  }

  /** Variante sans exception : `undefined` quand aucun worker ne convient. */
  async trySelect(request: SelectionRequest): Promise<SelectionResult | undefined> {
    const devices = await this.#registry.listDevices(request.userId);
    const candidates: ScoredCandidate[] = [];
    const rejected: SelectionResult["rejected"] = [];

    for (const device of devices) {
      const reason = this.#reject(device, request);
      if (reason !== undefined) {
        rejected.push({ deviceId: device.id, name: device.name, reason });
        continue;
      }
      candidates.push(this.#score(device, request));
    }

    if (candidates.length === 0) return undefined;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best === undefined) return undefined;

    return { device: best.device, score: best.score, candidates, rejected };
  }

  /** Tous les workers éligibles, ordonnés. Sert au repli après un échec. */
  async listEligible(request: SelectionRequest): Promise<ScoredCandidate[]> {
    return (await this.trySelect(request))?.candidates ?? [];
  }

  /**
   * Filtres durs. Chacun est une question de sécurité, pas de préférence.
   *
   * L'ordre est celui du diagnostic : on répond d'abord « ce n'est pas un
   * exécutant », puis « il est hors ligne », puis « il n'est pas autorisé ».
   */
  #reject(device: Device, request: SelectionRequest): string | undefined {
    if (request.excludeDeviceIds?.includes(device.id) === true) {
      return "excluded for this task";
    }

    // 1. Rôle. Un client n'exécute rien — sauf s'il est explicitement BOTH.
    if (!canAcceptTasks(device.role)) {
      return `role ${device.role}: this device is a client, not an executor`;
    }

    // 2. Révocation, avant toute autre chose.
    if (device.trust === "REVOKED" || device.revokedAt !== null) {
      return "device revoked";
    }

    // 3. Confiance. Un appareil appairé mais non approuvé n'exécute rien.
    if (device.trust !== "TRUSTED") {
      return "device not approved yet";
    }

    // 4. Disponibilité réelle : en ligne ET session authentifiée ouverte.
    if (!isOperational(device)) {
      return device.status === "ONLINE" ? "session not authenticated" : "offline";
    }

    // 5. Capacités déclarées.
    const missing = missingCapabilities(device.capabilities, request.requiredCapabilities);
    if (missing.length > 0) {
      return `missing capability: ${missing.join(", ")}`;
    }

    // 6. Permissions. Une capacité déclarée n'est pas une autorisation :
    //    l'appareil sait le faire, encore faut-il que ce soit permis.
    const granted = new Set([...device.grantedPermissions]);
    const unauthorized = request.requiredCapabilities.filter(
      (capability) => !isPermitted(granted, permissionForCapability(capability)),
    );
    if (unauthorized.length > 0) {
      return `permission not granted: ${unauthorized.join(", ")}`;
    }

    // 7. Saturation.
    if (device.health.activeTasks >= device.health.maxConcurrentTasks) {
      return `already busy (${String(device.health.activeTasks)} task(s) running)`;
    }

    // 8. Contraintes de la tâche.
    const constraints = request.constraints;
    if (constraints?.deviceTypes !== undefined && !constraints.deviceTypes.includes(device.type)) {
      return `type ${device.type} does not match the constraint`;
    }
    if (constraints?.platforms !== undefined && !constraints.platforms.includes(device.platform)) {
      return `platform ${device.platform} does not match the constraint`;
    }
    if (constraints?.requireMainsPower === true && device.health.onBattery === true) {
      return "on battery while the task requires mains power";
    }

    return undefined;
  }

  #score(device: Device, request: SelectionRequest): ScoredCandidate {
    const weights = this.#weights;
    const reasons: string[] = [];
    let score = 0;

    if (request.preferredDeviceId === device.id) {
      score += weights.preference;
      reasons.push("choisi explicitement par l'utilisateur");
    }

    const capacity = device.health.maxConcurrentTasks;
    const free = Math.max(0, capacity - device.health.activeTasks) / capacity;
    score += free * weights.availability;
    if (device.health.activeTasks === 0) reasons.push("aucune tâche en cours");

    const cpuFree = 1 - (device.health.cpuLoad ?? 0.5);
    score += cpuFree * weights.health;

    if (device.health.latencyMs !== undefined) {
      // 0 ms vaut le poids plein, 500 ms et au-delà ne valent rien.
      const latencyScore = Math.max(0, 1 - device.health.latencyMs / 500);
      score += latencyScore * weights.latency;
    }

    if (device.health.onBattery === false) {
      score += weights.mainsPower;
      reasons.push("sur secteur");
    }

    // À égalité par ailleurs, le worker le plus spécialisé gagne : mobiliser un
    // poste polyvalent pour une tâche qu'un appareil dédié sait faire le rend
    // indisponible pour ce que lui seul peut faire.
    const extra = device.capabilities.length - request.requiredCapabilities.length;
    score += Math.max(0, 1 - extra / 20) * weights.specialization;

    return { device, score: Math.round(score), reasons };
  }

  /** Motifs de rejet, y compris pour les appareils sans capacité requise. */
  async #explain(request: SelectionRequest): Promise<SelectionResult["rejected"]> {
    const devices = await this.#registry.listDevices(request.userId);
    const rejected: SelectionResult["rejected"] = [];

    for (const device of devices) {
      const reason = this.#reject(device, request);
      if (reason !== undefined) {
        rejected.push({ deviceId: device.id, name: device.name, reason });
      }
    }
    return rejected;
  }
}

/** Un joker de domaine (`terminal.*`) ou global (`*`) couvre la permission. */
function isPermitted(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has("*") || granted.has(required)) return true;

  const domain = required.split(".")[0];
  return domain !== undefined && granted.has(`${domain}.*`);
}
