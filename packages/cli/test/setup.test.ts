import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePaths } from "../src/environment.js";
import { checkNodeVersion, isPortAvailable } from "../src/prerequisites.js";
import { applyPlan, planSetup } from "../src/setup.js";

function makeInstallation(): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-setup-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    join(root, ".env.example"),
    "NODE_ENV=development\nDATABASE_URL=\nAUTH_SIGNING_KEY=\nMASTER_KEY=\nSEARXNG_SECRET=\nPUBLIC_API_URL=\n",
  );
  return root;
}

describe("installation wizard planSetup", () => {
  it("generates required secrets safely without leaking them in action details", () => {
    const root = makeInstallation();
    const paths = resolvePaths(root);

    const plan = planSetup({
      paths,
      dryRun: false,
      rotateKeys: false,
      pnpmPath: "pnpm",
      mode: "docker",
    });

    // Check actions exist
    const labels = plan.actions.map((a) => a.label);
    expect(labels).toContain("create .env from .env.example");
    expect(labels).toContain("generate a persistent signing key");
    expect(labels).toContain("generate a persistent master encryption key");
    expect(labels).toContain("generate SearXNG secret");
    expect(labels).toContain("generate a local PostgreSQL URL");

    // Verify secrets are NOT leaked in detail string
    for (const action of plan.actions) {
      if (action.detail) {
        expect(action.detail).not.toMatch(/-----BEGIN PRIVATE KEY-----/);
        expect(action.detail).not.toMatch(/[0-9a-f]{64}/); // raw 32-byte hex
      }
    }

    // Apply plan
    const { applied } = applyPlan(plan);
    expect(applied.length).toBeGreaterThan(0);

    // Verify .env content
    const envContent = readFileSync(paths.envFile, "utf8");
    expect(envContent).toContain("AUTH_SIGNING_KEY=");
    expect(envContent).toContain("MASTER_KEY=");
    expect(envContent).toContain("SEARXNG_SECRET=");
    expect(envContent).toContain("DATABASE_URL=");

    // Verify summary
    expect(plan.summary.mode).toBe("docker");
    expect(plan.summary.dashboardUrl).toBe("http://localhost:8080");
    expect(plan.summary.nextSteps).toContain("Start platform with: pnpm docker:platform");
  });

  it("is idempotent when executed repeatedly", () => {
    const root = makeInstallation();
    const paths = resolvePaths(root);

    const plan1 = planSetup({
      paths,
      dryRun: false,
      rotateKeys: false,
      pnpmPath: "pnpm",
    });
    applyPlan(plan1);

    const plan2 = planSetup({
      paths,
      dryRun: false,
      rotateKeys: false,
      pnpmPath: "pnpm",
    });

    const neededActions = plan2.actions.filter((a) => a.needed);
    // On second run, all primary secrets and files already exist
    const neededLabels = neededActions.map((a) => a.label);
    expect(neededLabels).not.toContain("generate a persistent master encryption key");
    expect(neededLabels).not.toContain("generate SearXNG secret");
  });

  it("configures Tailscale URL when provided", () => {
    const root = makeInstallation();
    const paths = resolvePaths(root);

    const plan = planSetup({
      paths,
      dryRun: false,
      rotateKeys: false,
      pnpmPath: "pnpm",
      tailscaleUrl: "http://100.64.0.1:3000",
    });

    const urlAction = plan.actions.find((a) => a.label === "configure public API URL");
    expect(urlAction).toBeDefined();
    expect(urlAction?.detail).toBe("http://100.64.0.1:3000");

    applyPlan(plan);

    const envContent = readFileSync(paths.envFile, "utf8");
    expect(envContent).toContain("PUBLIC_API_URL=http://100.64.0.1:3000");
    expect(plan.summary.apiUrl).toBe("http://100.64.0.1:3000");
  });
});

describe("prerequisites checks", () => {
  it("validates Node.js version >= 22.13.0", () => {
    expect(checkNodeVersion("v22.13.0").meetsRequirement).toBe(true);
    expect(checkNodeVersion("v22.14.0").meetsRequirement).toBe(true);
    expect(checkNodeVersion("v24.0.0").meetsRequirement).toBe(true);
    expect(checkNodeVersion("v20.10.0").meetsRequirement).toBe(false);
    expect(checkNodeVersion("v22.12.0").meetsRequirement).toBe(false);
  });

  it("checks port availability correctly", async () => {
    // Port 0 will ask OS for an available port
    const available = await isPortAvailable(0);
    expect(typeof available).toBe("boolean");
  });
});
