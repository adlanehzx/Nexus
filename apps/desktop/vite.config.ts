import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Build de l'interface Windows.
 *
 * La coquille Tauri sert ces fichiers depuis le disque ; il n'y a pas de serveur
 * web en production. `base: "./"` rend donc les chemins relatifs, sans quoi la
 * fenêtre native chercherait ses ressources à la racine d'un domaine qui
 * n'existe pas.
 */

/**
 * Cœur local en développement.
 *
 * `index.html` déclare `connect-src 'self' https: wss:` — la règle de
 * production, et elle est juste : le jeton de session ne doit jamais partir en
 * clair. Mais elle interdit aussi `http://localhost:3000`, si bien qu'un cœur
 * lancé sur la machine du développeur était injoignable, et que l'interface
 * n'affichait qu'un « Failed to fetch » sans cause.
 *
 * Ce greffon ajoute la boucle locale — **et uniquement elle** — quand le mode
 * n'est pas `production`. Le paquet livré n'est pas touché : un `vite build`
 * ordinaire conserve la CSP stricte, ce qu'un test vérifie.
 */
function cspDeveloppement(mode: string): Plugin {
  const LOCAL = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "ws://localhost:*",
    "ws://127.0.0.1:*",
  ].join(" ");

  return {
    name: "nexus-csp-developpement",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (mode === "production") return html;

        return html.replace(
          /connect-src ([^"]*)"/,
          (_match, valeur: string) => `connect-src ${valeur.trim()} ${LOCAL}"`,
        );
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), cspDeveloppement(mode)],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5273, strictPort: true },
}));
