import type { PrismaClient } from "@nexus/database";
import type { PairingTicket, PairingTicketStore } from "@nexus/devices";

/**
 * Pairing tickets on PostgreSQL.
 *
 * Nothing more than a conversion: logic — single use, expiration,
 * hash instead of plaintext code — lives in `PairingService`, which is tested without
 * a database. This store makes no policy decisions, which makes it easy to review in
 * one minute to ensure it writes no secrets.
 */
export class PrismaPairingTicketStore implements PairingTicketStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async save(ticket: PairingTicket): Promise<void> {
    const row = {
      userId: ticket.userId,
      codeHash: ticket.codeHash,
      createdAt: ticket.createdAt,
      expiresAt: ticket.expiresAt,
      consumedAt: ticket.consumedAt,
      deviceId: ticket.deviceId,
      label: ticket.label,
    };
    // `upsert` because `save` is used for issuance **and** redemption: the
    // service returns a modified ticket and entrusts it to the store without knowing whether
    // it already exists. Two separate methods would shift this logic to
    // the caller, which has no reason to handle it.
    await this.#prisma.devicePairingTicket.upsert({
      where: { id: ticket.id },
      create: { id: ticket.id, ...row },
      update: { consumedAt: ticket.consumedAt, deviceId: ticket.deviceId, label: ticket.label },
    });
  }

  async findByCodeHash(codeHash: string): Promise<PairingTicket | undefined> {
    const row = await this.#prisma.devicePairingTicket.findUnique({ where: { codeHash } });
    return row === null ? undefined : present(row);
  }

  async listByUser(userId: string): Promise<PairingTicket[]> {
    const rows = await this.#prisma.devicePairingTicket.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map(present);
  }

  /**
   * Deletes tickets that are no longer useful.
   *
   * A consumed or expired ticket has no further purpose, and keeping it unnecessarily
   * expands a table where every row carries the hash of a secret.
   * `deleteMany` returns the count, allowing the caller to log it
   * without re-reading the table.
   */
  async prune(before: Date): Promise<number> {
    const { count } = await this.#prisma.devicePairingTicket.deleteMany({
      where: {
        createdAt: { lte: before },
        OR: [{ consumedAt: { not: null } }, { expiresAt: { lte: before } }],
      },
    });
    return count;
  }
}

interface Row {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  deviceId: string | null;
  label: string | null;
}

function present(row: Row): PairingTicket {
  return {
    id: row.id,
    userId: row.userId,
    codeHash: row.codeHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    deviceId: row.deviceId,
    label: row.label,
  };
}
