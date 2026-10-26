import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dashboard build configuration.
 *
 * `base: "./"`: it is served either at a domain root or under a subpath behind
 * a reverse proxy, and absolute paths would silently break the second case.
 */
export default defineConfig({
  plugins: [react()],
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
