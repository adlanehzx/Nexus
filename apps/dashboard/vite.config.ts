import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Development only: allows the API chosen through `VITE_NEXUS_URL`.
 *
 * The shipped policy names the default development port. Without this, pointing
 * the dev server at another API fails with a CSP violation instead of connecting.
 */
function allowConfiguredDevApi(): Plugin {
  return {
    name: "nexus-dev-api-csp",
    apply: "serve",
    transformIndexHtml(html) {
      const configured = process.env["VITE_NEXUS_URL"]?.trim();
      if (configured === undefined || configured.length === 0) return html;
      const { origin, host, protocol } = new URL(configured);
      const socket = `${protocol === "https:" ? "wss" : "ws"}://${host}`;
      return html.replace("connect-src 'self'", `connect-src 'self' ${origin} ${socket}`);
    },
  };
}

/**
 * Dashboard build configuration.
 *
 * `base: "./"`: it is served either at a domain root or under a subpath behind
 * a reverse proxy, and absolute paths would silently break the second case.
 */
export default defineConfig({
  plugins: [react(), allowConfiguredDevApi()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5274, strictPort: true },
  preview: {
    // Vite rejects unknown Host headers to prevent DNS-rebinding attacks.
    // `.ts.net` is Tailscale's private MagicDNS namespace; permitting that
    // suffix keeps remote dashboard access private without accepting arbitrary
    // internet hostnames or using the unsafe `allowedHosts: true` escape hatch.
    allowedHosts: ["localhost", "127.0.0.1", ".ts.net"],
  },
});
