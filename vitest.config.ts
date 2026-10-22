import { defineConfig } from "vitest/config";

/**
 * Default Vitest configuration inherited by packages without their own file.
 * Each package runs through Turborepo so caching remains package-scoped.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "**/*.config.ts"],
    },
  },
});
