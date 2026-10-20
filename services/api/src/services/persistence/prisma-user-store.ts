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
          `Adresse déjà enregistrée : ${email}`,
          "Un compte existe déjà avec cette adresse.",
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
 * Resserre le rôle lu en base sur l'union du domaine.
 *
 * La colonne est un `TEXT` nullable : Prisma la rend donc `string | null`, et
 * rien ne garantit au compilateur qu'elle ne contient que les deux valeurs
 * attendues. Le défaut `USER` est le choix sûr — un rôle illisible ne doit pas
 * accorder des droits d'administration.
 */
function toUserRole(value: string | null): UserRole {
  return value === "ADMIN" ? "ADMIN" : "USER";
}

/**
 * Violation de contrainte d'unicité Prisma (`P2002`).
 *
 * L'erreur d'un `catch` est `unknown`, et c'est exact : rien ne promet qu'elle
 * porte un `code`. On le vérifie donc, au lieu de l'affirmer avec un `any` qui
 * ferait aussi taire le compilateur sur tout le reste du bloc.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
