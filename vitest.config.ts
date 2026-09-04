import { defineConfig } from "vitest/config";

/**
 * Configuration Vitest par défaut, héritée par les paquets qui n'en définissent
 * pas. Chaque paquet exécute ses propres tests via Turborepo, ce qui garde le
 * cache par paquet.
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
