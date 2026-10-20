import type { PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import {
  NotFoundError,
  type Notification,
  type NotificationStore,
  type Page,
  type PageRequest,
} from "../stores.js";

export class PrismaNotificationStore implements NotificationStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async create(input: Omit<Notification, "id" | "createdAt" | "readAt">): Promise<Notification> {
    const record = await this.#prisma.notification.create({
      data: { id: uuidv7(), ...input },
    });
    return present(record);
  }

  async get(id: string): Promise<Notification | undefined> {
    const record = await this.#prisma.notification.findUnique({ where: { id } });
    return record === null ? undefined : present(record);
  }

  async listByUser(
    userId: string,
    page: PageRequest,
    options: { unreadOnly?: boolean } = {},
  ): Promise<Page<Notification>> {
    const where = { userId, ...(options.unreadOnly === true ? { readAt: null } : {}) };
    const [records, total] = await Promise.all([
      this.#prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: page.limit + 1,
        ...(page.cursor === undefined ? {} : { cursor: { id: page.cursor }, skip: 1 }),
      }),
      this.#prisma.notification.count({ where }),
    ]);
    const hasMore = records.length > page.limit;
    const items = records.slice(0, page.limit).map(present);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      total,
    };
  }

  async markRead(id: string, at: Date): Promise<Notification> {
    const existing = await this.#prisma.notification.findUnique({ where: { id } });
    if (existing === null) throw new NotFoundError("Notification", id);
    if (existing.readAt !== null) return present(existing);
    return present(await this.#prisma.notification.update({ where: { id }, data: { readAt: at } }));
  }
}

function present(record: {
  id: string;
  userId: string;
  title: string;
  body: string;
  severity: string;
  originClientDeviceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): Notification {
  if (record.severity !== "info" && record.severity !== "warning" && record.severity !== "error") {
    throw new Error(`Invalid notification severity: ${record.severity}`);
  }
  return { ...record, severity: record.severity };
}
