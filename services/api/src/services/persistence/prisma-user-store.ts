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
            },
          },
        },
      });
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: toUserRole(user.role),
        status: user.status as "ACTIVE" | "SUSPENDED",
        createdAt: user.createdAt,
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(
          `Email already registered: ${email}`,
          "An account already exists with this email address.",
        );
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
      role: toUserRole(user.role),
      status: user.status as "ACTIVE" | "SUSPENDED",
      createdAt: user.createdAt,
    };
  }

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const user = await this.#prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { authCredential: true },
    });
    if (!user?.authCredential) return undefined;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: toUserRole(user.role),
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

/**
 * Narrows the role read from the database to the domain union.
 *
 * The column is a nullable `TEXT`: Prisma therefore returns it as `string | null`, and
 * nothing guarantees to the compiler that it only contains the two expected
 * values. The default `USER` is the safe choice — an unreadable role must not
 * grant administration privileges.
 */
function toUserRole(value: string | null): UserRole {
  return value === "ADMIN" ? "ADMIN" : "USER";
}

/**
 * Prisma unique constraint violation (`P2002`).
 *
 * The error in a `catch` block is `unknown`, and properly so: nothing guarantees that it
 * carries a `code`. We therefore verify it instead of asserting with `any`, which
 * would also silence the compiler on the rest of the block.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
