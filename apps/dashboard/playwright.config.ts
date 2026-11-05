import { defineConfig } from "@playwright/test";

/**
 * Browser journeys against an application that is already running.
 *
 * Nothing is mocked here: `NEXUS_E2E_DASHBOARD_URL` and `NEXUS_E2E_API_URL` must
 * point at a real dashboard and API backed by a disposable PostgreSQL and Redis.
 * See `docs/audits/full-product-integration.md` for the startup commands.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: process.env["NEXUS_E2E_OUTPUT_DIR"] ?? "/tmp/nexus-e2e-results",
  use: {
    baseURL: process.env["NEXUS_E2E_DASHBOARD_URL"] ?? "http://127.0.0.1:5277",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
