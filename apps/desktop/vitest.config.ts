import { defineConfig } from "vitest/config";

/**
 * Les tests ne montent aucun composant.
 *
 * Ce qui mérite d'être éprouvé ici — le statut du worker local, le cloisonnement
 * entre l'interface et l'exécution — est du TypeScript sans DOM. Simuler un
 * navigateur pour l'entourer n'ajouterait aucune garantie et ferait passer pour
 * vérifié ce qui ne l'est pas : le rendu réel, lui, demande la vraie fenêtre.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
