import { defineConfig } from "vitest/config";

/**
 * Tests do not mount any component.
 *
 * What deserves verification here is DOM-less TypeScript: metrics formatting,
 * health status categorization, and ensuring the application never requests a
 * field it is not permitted to observe.
 */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
