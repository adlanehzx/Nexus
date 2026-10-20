import { defineConfig } from "vitest/config";

/**
 * Tests d'intégration contre un PostgreSQL réel.
 *
 * Séparés du run par défaut parce qu'ils exigent une base, et que `pnpm test`
 * doit rester exécutable sans service. Ce n'est pas une préférence de confort :
 * un défaut de production avait précisément échappé aux doublures en mémoire —
 * le magasin de tâches écrivait des statuts que l'enum PostgreSQL refusait, et
 * aucun test ne pouvait le voir.
 *
 * Lancés par `pnpm test:pg`, avec `DATABASE_URL` pointant sur une base jetable.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.pg.test.ts"],
    // Une base partagée et des tests en parallèle se marcheraient dessus sur
    // les contraintes d'unicité. La séquence est le choix sûr, et ces tests
    // sont peu nombreux.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
