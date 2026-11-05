import type { PrismaClient } from "@nexus/database";
import type { DeliveryReport } from "@nexus/devices";

/**
 * Push to devices whose socket is gone.
 *
 * Only devices the router could not reach get a push: one still connected has already
 * received the frame, and a second alert would only repeat it.
 *
 * **Bodies are fixed text.** A lock screen shows them, and they cross Expo's servers, so
 * nothing from the event's content goes in: no title, task name or tool argument.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const SEND_TIMEOUT_MS = 10_000;

export interface PushTokenRecord {
  deviceId: string;
  userId: string;
  token: string;
  provider: "expo";
}

export interface PushTokenStore {
  save(record: PushTokenRecord): Promise<void>;
  delete(deviceId: string): Promise<void>;
  deleteToken(token: string): Promise<void>;
  listForDevices(deviceIds: readonly string[]): Promise<PushTokenRecord[]>;
}

export class InMemoryPushTokenStore implements PushTokenStore {
  readonly #byDevice = new Map<string, PushTokenRecord>();

  save(record: PushTokenRecord): Promise<void> {
    this.#byDevice.set(record.deviceId, record);
    return Promise.resolve();
  }

  delete(deviceId: string): Promise<void> {
    this.#byDevice.delete(deviceId);
    return Promise.resolve();
  }

  deleteToken(token: string): Promise<void> {
    for (const [deviceId, record] of this.#byDevice) {
      if (record.token === token) this.#byDevice.delete(deviceId);
    }
    return Promise.resolve();
  }

  listForDevices(deviceIds: readonly string[]): Promise<PushTokenRecord[]> {
    return Promise.resolve(
      deviceIds.flatMap((id) => {
        const record = this.#byDevice.get(id);
        return record === undefined ? [] : [record];
      }),
    );
  }
}

export class PrismaPushTokenStore implements PushTokenStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async save(record: PushTokenRecord): Promise<void> {
    await this.#prisma.pushToken.upsert({
      where: { deviceId: record.deviceId },
      create: record,
      update: { token: record.token, provider: record.provider, userId: record.userId },
    });
  }

  async delete(deviceId: string): Promise<void> {
    await this.#prisma.pushToken.deleteMany({ where: { deviceId } });
  }

  async deleteToken(token: string): Promise<void> {
    await this.#prisma.pushToken.deleteMany({ where: { token } });
  }

  async listForDevices(deviceIds: readonly string[]): Promise<PushTokenRecord[]> {
    const rows = await this.#prisma.pushToken.findMany({
      where: { deviceId: { in: [...deviceIds] } },
    });
    return rows.map((row) => ({
      deviceId: row.deviceId,
      userId: row.userId,
      token: row.token,
      provider: "expo" as const,
    }));
  }
}

const ALERTS: Readonly<Record<string, { title: string; body: string; route: string }>> = {
  "confirmation.required": {
    title: "NEXUS",
    body: "An action is waiting for your decision.",
    route: "/",
  },
  "task.completed": { title: "NEXUS", body: "A task has finished.", route: "/missions" },
  "task.failed": { title: "NEXUS", body: "A task has failed.", route: "/missions" },
  "notification.created": {
    title: "NEXUS",
    body: "You have a new notification.",
    route: "/notifications",
  },
};

export class PushNotificationService {
  readonly #store: PushTokenStore;
  readonly #fetch: typeof fetch;
  readonly #onError: ((cause: unknown) => void) | undefined;

  constructor(options: {
    store: PushTokenStore;
    fetchFn?: typeof fetch;
    onError?: (cause: unknown) => void;
  }) {
    this.#store = options.store;
    this.#fetch = options.fetchFn ?? fetch;
    this.#onError = options.onError;
  }

  register(record: PushTokenRecord): Promise<void> {
    return this.#store.save(record);
  }

  unregister(deviceId: string): Promise<void> {
    return this.#store.delete(deviceId);
  }

  /** Never rejects: a push that fails must not disturb what emitted the event. */
  async deliver(report: DeliveryReport): Promise<void> {
    const alert = ALERTS[report.event.type];
    if (alert === undefined || report.queuedFor.length === 0) return;
    try {
      const tokens = await this.#store.listForDevices(report.queuedFor);
      if (tokens.length === 0) return;
      const response = await this.#fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        body: JSON.stringify(
          tokens.map(({ token }) => ({
            to: token,
            title: alert.title,
            body: alert.body,
            data: { route: alert.route },
          })),
        ),
      });
      if (!response.ok) throw new Error(`Expo push answered ${String(response.status)}`);
      const { data } = (await response.json()) as {
        data?: { status?: string; details?: { error?: string } }[];
      };
      // Tickets come back in the order of the messages sent.
      await Promise.all(
        (data ?? []).map(async (ticket, index) => {
          const token = tokens[index]?.token;
          if (ticket.details?.error === "DeviceNotRegistered" && token !== undefined) {
            await this.#store.deleteToken(token);
          }
        }),
      );
    } catch (cause) {
      this.#onError?.(cause);
    }
  }
}
