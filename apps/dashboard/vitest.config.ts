import { defineConfig } from "vitest/config";

/**
 * Les tests ne montent aucun composant.
 *
 * Ce qui mérite d'être éprouvé ici est du TypeScript sans DOM : le formatage des
 * mesures, le classement des états de santé, et le fait que l'application ne
 * demande jamais un champ qu'elle n'a pas le droit de voir.
 */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
