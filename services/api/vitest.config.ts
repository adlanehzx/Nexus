import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Les tests d'intégration PostgreSQL ont leur propre configuration et leur
    // propre commande : ils exigent une base réelle, et les inclure ici
    // rendrait `pnpm test` dépendant d'un service.
    exclude: ["**/node_modules/**", "**/dist/**", "test/**/*.pg.test.ts"],
    // Les tests d'API partagent un serveur Fastify injecté : les isoler par
    // fichier évite les fuites d'état sans coûter le prix d'un process par test.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/generated/**"],
    },
  },
});
