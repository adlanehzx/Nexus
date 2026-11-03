import { defineConfig } from "vitest/config";

/**
 * Integration tests against the real ONNX embedding model.
 *
 * Run via `pnpm test:embeddings`. Excluded from the default suite because the
 * model is downloaded on first use and the run is measured in minutes, not
 * milliseconds — but it is the only test that proves semantic recall is real
 * rather than a deterministic hash approximation.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.embeddings.test.ts"],
    fileParallelism: false,
    pool: "forks",
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
