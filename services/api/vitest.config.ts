import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // PostgreSQL integration tests have their own config: they require a real database.
    exclude: ["**/node_modules/**", "**/dist/**", "test/**/*.pg.test.ts"],
    // API tests share an injected Fastify server: isolate per file.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/generated/**"],
    },
  },
});
