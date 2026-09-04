import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Les tests stdio lancent de vrais processus : on leur laisse de la marge.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: { provider: "v8", include: ["src/**/*.ts"] },
  },
});
