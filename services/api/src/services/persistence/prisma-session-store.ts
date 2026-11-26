import type { PrismaClient } from "@nexus/database";
import type { SessionStore, UserSession } from "../stores.js";

export class PrismaSessionStore implements SessionStore {
  readonly #prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async create(session: UserSession): Promise<void> {
    await this.#prisma.session.create({
      data: {
        id: session.id,
        userId: session.userId,
        refreshTokenHash: session.refreshTokenHash,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
      },
    });
  }

  async rotate(id: string, at: Date, successor: UserSession): Promise<boolean> {
    return this.#prisma.$transaction(async (tx) => {
      const consumed = await tx.session.updateMany({
        where: { id, userId: successor.userId, revokedAt: null, expiresAt: { gt: at } },
        data: { revokedAt: at },
      });
      if (consumed.count !== 1) return false;
      await tx.session.create({ data: successor });
      return true;
    });
  }

  async get(id: string): Promise<UserSession | undefined> {
    const s = await this.#prisma.session.findUnique({ where: { id } });
    if (!s) return undefined;
    return s;
  }

  async findByRefreshHash(hash: string): Promise<UserSession | undefined> {
    const s = await this.#prisma.session.findUnique({ where: { refreshTokenHash: hash } });
    if (!s) return undefined;
    return s;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.#prisma.session.update({
      where: { id },
      data: { revokedAt: at },
    });
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const res = await this.#prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
    return res.count;
  }
}
