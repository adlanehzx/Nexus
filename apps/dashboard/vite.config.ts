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
});
