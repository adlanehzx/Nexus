import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Build du tableau de bord.
 *
 * `base: "./"` : il est servi indifféremment à la racine d'un domaine ou sous un
 * sous-chemin derrière un reverse proxy, et des chemins absolus casseraient le
 * second cas sans prévenir.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5274, strictPort: true },
});
