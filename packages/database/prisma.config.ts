import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 configuration.
 *
 * As of Prisma v7, the database connection URL is no longer declared in
 * `schema.prisma`: migration commands read it here, and the application client
 * receives it via a driver adapter (cf. `src/client.ts`). The schema file only
 * defines the data model.
 *
 * Prisma 7 does not automatically load .env files; we load it explicitly from
 * monorepo root so `pnpm db:migrate` works from any working directory.
 */
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, ".env"), resolve(here, "../../.env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // URL is only provided if defined in environment.
  // `prisma generate` does not require a connection, ensuring Docker builds succeed.
  datasource: process.env["DATABASE_URL"] ? { url: process.env["DATABASE_URL"] } : {},
});
