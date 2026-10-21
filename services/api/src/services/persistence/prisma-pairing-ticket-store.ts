import type { PrismaClient } from "@nexus/database";
import type { PairingTicket, PairingTicketStore } from "@nexus/devices";

/**
 * Tickets d'appairage sur PostgreSQL.
 *
 * Rien de plus qu'une traduction : la logique — usage unique, expiration,
 * empreinte au lieu du code — vit dans `PairingService`, qui se teste sans
 * base. Ce magasin ne décide de rien, et c'est ce qui permet de le relire en
 * une minute pour se convaincre qu'il n'écrit aucun secret.
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
    // `upsert` parce que `save` sert à l'émission **et** à la consommation : le
    // service rend un ticket modifié et le confie au magasin sans savoir s'il
    // existe déjà. Deux méthodes distinctes déplaceraient ce choix chez
    // l'appelant, qui n'a aucune raison de s'en occuper.
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
   * Efface ce qui ne peut plus servir.
   *
   * Un ticket consommé ou périmé n'a plus d'usage, et le garder allonge
   * indéfiniment une table dont chaque ligne porte l'empreinte d'un secret.
   * `deleteMany` rend le compte, ce qui permet à l'appelant de le journaliser
   * sans relire la table.
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
