import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Windows desktop UI build.
 *
 * Tauri serves these files from disk in production without a web server.
 * `base: "./"` ensures relative asset paths.
 */

/**
 * Local core in development.
 *
 * `index.html` declares `connect-src 'self' https: wss:` for production.
 * This dev plugin permits loopback connections during local development.
 */
function cspDevelopment(mode: string): Plugin {
  const LOCAL = [
    "http://localhost:*",
    "http://127.0.0.1:*",
    "ws://localhost:*",
    "ws://127.0.0.1:*",
  ].join(" ");

  return {
    name: "nexus-csp-development",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (mode === "production") return html;

        return html.replace(
          /connect-src ([^"]*)"/,
          (_match, value: string) => `connect-src ${value.trim()} ${LOCAL}"`,
        );
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), cspDevelopment(mode)],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: { port: 5273, strictPort: true },
}));
