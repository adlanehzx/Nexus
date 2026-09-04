import type { PrismaClient } from "@nexus/database";
import { ConflictError } from "../stores.js";
import type { User, UserRecord, UserStore, UserRole } from "../stores.js";
import { uuidv7 } from "@nexus/shared";

export class PrismaUserStore implements UserStore {
  readonly #prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async create(input: { email: string; displayName: string; passwordHash: string }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const count = await this.count();
    const role = count === 0 ? "ADMIN" : "USER";

    try {
      const user = await this.#prisma.user.create({
        data: {
          id: uuidv7(),
          email,
          displayName: input.displayName,
          role,
          status: "ACTIVE",
          authCredential: {
            create: {
              id: uuidv7(),
              passwordHash: input.passwordHash,
            }
          }
        }
      });
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: (user as any).role as UserRole ?? 'USER',
        status: user.status as "ACTIVE" | "SUSPENDED",
        createdAt: user.createdAt,
      };
    } catch (err: any) {
      if (err.code === "P2002") {
        throw new ConflictError(`Adresse d�j� enregistr�e : ${email}`, "Un compte existe d�j� avec cette adresse.");
      }
      throw err;
    }
  }

  async findById(id: string): Promise<User | undefined> {
    const user = await this.#prisma.user.findUnique({ where: { id } });
    if (!user) return undefined;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: (user as any).role as UserRole ?? 'USER',
      status: user.status as "ACTIVE" | "SUSPENDED",
      createdAt: user.createdAt,
    };
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const user = await this.#prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { authCredential: true },
    });
    if (!user || !user.authCredential) return undefined;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: (user as any).role as UserRole ?? 'USER',
      status: user.status as "ACTIVE" | "SUSPENDED",
      createdAt: user.createdAt,
      passwordHash: user.authCredential.passwordHash,
    };
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.#prisma.authCredential.update({
      where: { userId: id },
      data: { passwordHash },
    });
  }

  async count(): Promise<number> {
    return this.#prisma.user.count();
  }

  async setRole(id: string, role: UserRole): Promise<void> {
    await this.#prisma.user.update({
      where: { id },
      data: { role },
    });
  }
}

