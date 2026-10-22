import { defineConfig } from "vitest/config";

/**
 * Integration tests against a real PostgreSQL instance.
 * Run via `pnpm test:pg` with `DATABASE_URL`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.pg.test.ts"],
    // Shared database tests run sequentially to prevent uniqueness constraint conflicts.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
