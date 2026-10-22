import { defineConfig } from "vitest/config";

/**
 * Desktop unit tests.
 *
 * Verifies local worker status, isolation boundaries, and security rules.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
