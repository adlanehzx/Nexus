import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Build de l'interface Windows.
 *
 * La coquille Tauri sert ces fichiers depuis le disque ; il n'y a pas de serveur
 * web en production. `base: "./"` rend donc les chemins relatifs, sans quoi la
 * fenêtre native chercherait ses ressources à la racine d'un domaine qui
 * n'existe pas.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5273, strictPort: true },
});
