import { uuidv7 } from "@nexus/shared";
import type { InputJsonObject, PrismaClient } from "@nexus/database";
import type { DeviceStore, Device } from "@nexus/devices";

export class PrismaDeviceStore implements DeviceStore {
  readonly #prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async save(device: Device): Promise<void> {
    const caps = device.capabilities.map((c) => ({
      id: uuidv7(),
      name: c.name,
      version: c.version,
      description: c.description,
      enabled: c.enabled,
      metadata: c.metadata,
      ...jsonField("inputSchema", c.inputSchema),
    }));

    await this.#prisma.device.upsert({
      where: { id: device.id },
      create: {
        id: device.id,
        userId: device.userId,
        name: device.name,
        type: device.type,
        platform: device.platform,
        role: device.role,
        status: device.status,
        trust: device.trust,
        agentVersion: device.agentVersion,
        health: device.health,
        grantedPermissions: device.grantedPermissions,
        metadata: device.metadata,
        lastSeenAt: device.lastSeenAt,
        pairedAt: device.pairedAt,
        revokedAt: device.revokedAt,
        capabilities: {
          create: caps,
        },
      },
      update: {
        name: device.name,
        status: device.status,
        trust: device.trust,
        agentVersion: device.agentVersion,
        health: device.health,
        grantedPermissions: device.grantedPermissions,
        metadata: device.metadata,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
      },
    });

    for (const cap of device.capabilities) {
      await this.#prisma.deviceCapability.upsert({
        where: { deviceId_name: { deviceId: device.id, name: cap.name } },
        create: {
          id: uuidv7(),
          deviceId: device.id,
          name: cap.name,
          version: cap.version,
          description: cap.description,
          enabled: cap.enabled,
          metadata: cap.metadata,
          ...jsonField("inputSchema", cap.inputSchema),
        },
        update: {
          version: cap.version,
          description: cap.description,
          enabled: cap.enabled,
          metadata: cap.metadata,
          ...jsonField("inputSchema", cap.inputSchema),
        },
      });
    }
  }

  async get(id: string): Promise<Device | undefined> {
    const device = await this.#prisma.device.findUnique({
      where: { id },
      include: { capabilities: true },
    });
    if (!device) return undefined;
    return device as unknown as Device;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.#prisma.device.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async listByUser(userId: string): Promise<Device[]> {
    const devices = await this.#prisma.device.findMany({
      where: { userId },
      include: { capabilities: true },
    });
    return devices as unknown as Device[];
  }
}

/**
 * Champ JSON facultatif d'une entrée Prisma.
 *
 * `exactOptionalPropertyTypes` est actif, et les types d'entrée de Prisma
 * n'acceptent pas `undefined` sur une colonne `Json` : passer la clé à
 * `undefined` est refusé, l'omettre est accepté. On omet donc, plutôt que de
 * masquer le désaccord sous un `as any` — un cast ici laisserait aussi passer
 * une valeur non sérialisable.
 */
function jsonField<K extends string>(
  key: K,
  value: Record<string, unknown> | undefined,
): Record<K, InputJsonObject> | Record<string, never> {
  // L'assertion est ici, une fois, et elle est précise : `InputJsonObject`,
  // pas `any`. Ce qu'elle affirme est vrai par construction — ces objets
  // viennent de schémas JSON validés par Zod — et si elle devenait fausse, le
  // compilateur continuerait de vérifier tout le reste de l'appel.
  return value === undefined
    ? {}
    : ({ [key]: value as InputJsonObject } as Record<K, InputJsonObject>);
}
