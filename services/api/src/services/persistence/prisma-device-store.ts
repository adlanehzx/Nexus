import { uuidv7 } from '@nexus/shared';
import type { PrismaClient } from "@nexus/database";
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
      inputSchema: c.inputSchema as any,
      enabled: c.enabled,
      metadata: c.metadata as any,
    }));

    await this.#prisma.device.upsert({
      where: { id: device.id },
      create: {
        id: device.id,
        userId: device.userId,
        name: device.name,
        type: device.type as any,
        platform: device.platform as any,
        role: device.role as any,
        status: device.status as any,
        trust: device.trust as any,
        agentVersion: device.agentVersion,
        health: device.health as any,
        grantedPermissions: device.grantedPermissions,
        metadata: device.metadata as any,
        lastSeenAt: device.lastSeenAt,
        pairedAt: device.pairedAt,
        revokedAt: device.revokedAt,
        capabilities: {
          create: caps,
        },
      },
      update: {
        name: device.name,
        status: device.status as any,
        trust: device.trust as any,
        agentVersion: device.agentVersion,
        health: device.health as any,
        grantedPermissions: device.grantedPermissions,
        metadata: device.metadata as any,
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
          inputSchema: cap.inputSchema as any,
          enabled: cap.enabled,
          metadata: cap.metadata as any,
        },
        update: {
          version: cap.version,
          description: cap.description,
          inputSchema: cap.inputSchema as any,
          enabled: cap.enabled,
          metadata: cap.metadata as any,
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

