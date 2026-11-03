import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The real-model integration suite has its own config: it downloads a
    // multilingual model and runs for minutes.
    exclude: ["**/node_modules/**", "**/dist/**", "test/**/*.embeddings.test.ts"],
  },
});
