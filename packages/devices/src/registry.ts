import { uuidv7 } from "@nexus/shared";
import { hasCapability, mergeCapabilities } from "./capabilities.js";
import { DeviceNotFoundError } from "./errors.js";
import {
  DEFAULT_HEALTH,
  canAcceptTasks,
  canReceiveEvents,
  isOperational,
  type Device,
  type DeviceCapability,
  type DeviceHealth,
  type RegisterDeviceInput,
} from "./types.js";

/**
 * Port de persistance des appareils.
 *
 * Le registre ne connaît pas la base : l'implémentation Prisma arrivera avec le
 * service, sans toucher à cette logique. Même raison que pour `AgentRunStore` —
 * ce qui se teste sans PostgreSQL se teste vraiment.
 */
export interface DeviceStore {
  save(device: Device): Promise<void>;
  get(id: string): Promise<Device | undefined>;
  delete(id: string): Promise<boolean>;
  listByUser(userId: string): Promise<Device[]>;
}

export class InMemoryDeviceStore implements DeviceStore {
  readonly #devices = new Map<string, Device>();

  save(device: Device): Promise<void> {
    // Copie défensive : un appelant qui muterait son objet après coup
    // corromprait silencieusement l'état enregistré.
    this.#devices.set(device.id, structuredClone(device));
    return Promise.resolve();
  }

  get(id: string): Promise<Device | undefined> {
    const device = this.#devices.get(id);
    return Promise.resolve(device === undefined ? undefined : structuredClone(device));
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#devices.delete(id));
  }

  listByUser(userId: string): Promise<Device[]> {
    return Promise.resolve(
      [...this.#devices.values()]
        .filter((device) => device.userId === userId)
        .map((device) => structuredClone(device)),
    );
  }

  get size(): number {
    return this.#devices.size;
  }
}

export type DeviceChange =
  | { kind: "registered"; device: Device }
  | { kind: "unregistered"; deviceId: string; userId: string }
  | { kind: "status"; device: Device; previous: Device["status"] }
  | { kind: "capabilities"; device: Device }
  | { kind: "trust"; device: Device; previous: Device["trust"] }
  | { kind: "health"; device: Device };

export interface DeviceRegistryOptions {
  store?: DeviceStore;
  /** Au-delà, un appareil sans battement de cœur passe hors ligne. */
  heartbeatTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
  onChange?: (change: DeviceChange) => void;
}

/**
 * Registre des appareils.
 *
 * Source de vérité sur qui existe, ce qu'il sait faire, et s'il est utilisable.
 * Il ne décide rien : c'est `DeviceSelector` qui choisit. Cette séparation
 * compte — le registre répond à « qu'existe-t-il ? », le sélecteur à « lequel ? ».
 */
export class DeviceRegistry {
  readonly #store: DeviceStore;
  readonly #heartbeatTimeoutMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #onChange: ((change: DeviceChange) => void) | undefined;

  constructor(options: DeviceRegistryOptions = {}) {
    this.#store = options.store ?? new InMemoryDeviceStore();
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#onChange = options.onChange;
  }

  // ── Cycle de vie ────────────────────────────────────────────────────────

  /**
   * Enregistre un appareil.
   *
   * Il arrive **hors ligne et non fiable** : la confiance se donne, elle ne se
   * suppose pas. Un appareil fraîchement appairé ne reçoit aucune tâche avant
   * qu'un humain l'ait approuvé.
   */
  async registerDevice(input: RegisterDeviceInput): Promise<Device> {
    const now = this.#now();
    const device: Device = {
      id: input.id ?? this.#newId(),
      userId: input.userId,
      name: input.name,
      type: input.type,
      platform: input.platform,
      role: input.role,
      status: "OFFLINE",
      trust: input.trust ?? "PENDING",
      capabilities: mergeCapabilities(input.capabilities ?? []),
      health: { ...DEFAULT_HEALTH },
      grantedPermissions: [...(input.grantedPermissions ?? [])],
      agentVersion: input.agentVersion ?? null,
      metadata: { ...(input.metadata ?? {}) },
      lastSeenAt: null,
      pairedAt: now,
      revokedAt: null,
      authenticated: false,
    };

    await this.#store.save(device);
    this.#emit({ kind: "registered", device });
    return device;
  }

  async unregisterDevice(id: string): Promise<boolean> {
    const device = await this.#store.get(id);
    if (device === undefined) return false;

    await this.#store.delete(id);
    this.#emit({ kind: "unregistered", deviceId: id, userId: device.userId });
    return true;
  }

  /** Mise à jour partielle. L'identité et le propriétaire ne changent jamais. */
  async updateDevice(
    id: string,
    patch: Partial<Omit<Device, "id" | "userId" | "pairedAt">>,
  ): Promise<Device> {
    const device = await this.requireDevice(id);
    const updated: Device = { ...device, ...patch, id: device.id, userId: device.userId };
    await this.#store.save(updated);
    return updated;
  }

  async getDevice(id: string): Promise<Device | undefined> {
    const device = await this.#store.get(id);
    return device === undefined ? undefined : this.#withFreshStatus(device);
  }

  async requireDevice(id: string): Promise<Device> {
    const device = await this.getDevice(id);
    if (device === undefined) throw new DeviceNotFoundError(id);
    return device;
  }

  async listDevices(userId: string): Promise<Device[]> {
    const devices = await this.#store.listByUser(userId);
    return devices.map((device) => this.#withFreshStatus(device));
  }

  // ── Requêtes par rôle ───────────────────────────────────────────────────

  async getClientDevices(userId: string): Promise<Device[]> {
    return (await this.listDevices(userId)).filter((device) => canReceiveEvents(device.role));
  }

  async getWorkerDevices(userId: string): Promise<Device[]> {
    return (await this.listDevices(userId)).filter((device) => canAcceptTasks(device.role));
  }

  async getOnlineClients(userId: string): Promise<Device[]> {
    return (await this.getClientDevices(userId)).filter((device) => device.status === "ONLINE");
  }

  async getOnlineWorkers(userId: string): Promise<Device[]> {
    return (await this.getWorkerDevices(userId)).filter(isOperational);
  }

  /**
   * Appareils déclarant **toutes** les capacités demandées.
   *
   * Aucun filtre de rôle ni de statut ici : la question posée est « qui sait
   * faire ça ? », pas « qui peut le faire maintenant ? ». Le sélecteur applique
   * les filtres d'éligibilité — les mélanger rendrait le diagnostic impossible
   * (« pourquoi cet appareil n'apparaît-il pas ? »).
   */
  async getDevicesByCapability(userId: string, required: readonly string[]): Promise<Device[]> {
    const devices = await this.listDevices(userId);
    return devices.filter((device) =>
      required.every((name) => hasCapability(device.capabilities, name)),
    );
  }

  // ── État ────────────────────────────────────────────────────────────────

  /**
   * Battement de cœur : l'appareil est vivant.
   *
   * Passe l'appareil en ligne s'il ne l'était pas. Un appareil révoqué reste
   * révoqué — un battement de cœur ne rend pas la confiance.
   */
  async updateHeartbeat(id: string, health?: Partial<DeviceHealth>): Promise<Device> {
    const device = await this.requireDevice(id);
    if (device.trust === "REVOKED" || device.revokedAt !== null) return device;

    const previous = device.status;
    const updated: Device = {
      ...device,
      status: "ONLINE",
      lastSeenAt: this.#now(),
      health: {
        ...device.health,
        ...health,
        reportedAt: this.#now().toISOString(),
      },
    };

    await this.#store.save(updated);
    if (previous !== "ONLINE") this.#emit({ kind: "status", device: updated, previous });
    return updated;
  }

  async updateCapabilities(id: string, capabilities: DeviceCapability[]): Promise<Device> {
    const device = await this.requireDevice(id);
    const updated: Device = { ...device, capabilities: mergeCapabilities(capabilities) };

    await this.#store.save(updated);
    this.#emit({ kind: "capabilities", device: updated });
    return updated;
  }

  async updateHealth(id: string, health: Partial<DeviceHealth>): Promise<Device> {
    const device = await this.requireDevice(id);
    const updated: Device = {
      ...device,
      health: { ...device.health, ...health, reportedAt: this.#now().toISOString() },
    };

    await this.#store.save(updated);
    this.#emit({ kind: "health", device: updated });
    return updated;
  }

  /** Marque la session comme ouverte ou close. */
  async setAuthenticated(id: string, authenticated: boolean): Promise<Device> {
    const device = await this.requireDevice(id);
    const previous = device.status;
    const updated: Device = {
      ...device,
      authenticated,
      status: authenticated ? device.status : "OFFLINE",
      lastSeenAt: authenticated ? this.#now() : device.lastSeenAt,
    };

    await this.#store.save(updated);
    if (previous !== updated.status) this.#emit({ kind: "status", device: updated, previous });
    return updated;
  }

  async markOffline(id: string): Promise<Device> {
    const device = await this.requireDevice(id);
    const previous = device.status;
    const updated: Device = { ...device, status: "OFFLINE", authenticated: false };

    await this.#store.save(updated);
    if (previous !== "OFFLINE") this.#emit({ kind: "status", device: updated, previous });
    return updated;
  }

  // ── Confiance ───────────────────────────────────────────────────────────

  async trustDevice(id: string): Promise<Device> {
    const device = await this.requireDevice(id);
    const previous = device.trust;
    const updated: Device = { ...device, trust: "TRUSTED" };

    await this.#store.save(updated);
    this.#emit({ kind: "trust", device: updated, previous });
    return updated;
  }

  async revokeTrust(id: string): Promise<Device> {
    const device = await this.requireDevice(id);
    const previous = device.trust;
    // La confiance retirée ramène en attente, pas à la révocation : c'est
    // réversible sans réappairage.
    const updated: Device = { ...device, trust: "PENDING", authenticated: false };

    await this.#store.save(updated);
    this.#emit({ kind: "trust", device: updated, previous });
    return updated;
  }

  /**
   * Révocation définitive.
   *
   * L'appareil reste en base — l'historique des tâches y renvoie — mais il ne
   * peut plus rien exécuter ni se reconnecter. Seul un réappairage complet le
   * remet en service.
   */
  async revokeDevice(id: string): Promise<Device> {
    const device = await this.requireDevice(id);
    const previousTrust = device.trust;
    const updated: Device = {
      ...device,
      trust: "REVOKED",
      status: "REVOKED",
      authenticated: false,
      revokedAt: this.#now(),
    };

    await this.#store.save(updated);
    this.#emit({ kind: "trust", device: updated, previous: previousTrust });
    return updated;
  }

  // ── Interne ─────────────────────────────────────────────────────────────

  /**
   * Un appareil silencieux depuis trop longtemps est hors ligne, même si sa
   * dernière écriture disait le contraire. Sans cela, un worker débranché
   * brutalement resterait éligible jusqu'à sa prochaine écriture — c'est-à-dire
   * jamais.
   */
  #withFreshStatus(device: Device): Device {
    if (device.status !== "ONLINE") return device;
    if (device.lastSeenAt === null) return { ...device, status: "OFFLINE" };

    const silentFor = this.#now().getTime() - device.lastSeenAt.getTime();
    return silentFor > this.#heartbeatTimeoutMs
      ? { ...device, status: "OFFLINE", authenticated: false }
      : device;
  }

  #emit(change: DeviceChange): void {
    try {
      this.#onChange?.(change);
    } catch {
      // La trace est un service rendu au registre, jamais une dépendance.
    }
  }
}
