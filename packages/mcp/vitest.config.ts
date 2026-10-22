import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // stdio tests launch real processes: give them adequate headroom.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: { provider: "v8", include: ["src/**/*.ts"] },
  },
});
