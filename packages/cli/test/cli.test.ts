import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  findRepositoryRoot,
  hasPersistentSigningKey,
  readEnvFile,
  resolvePaths,
  upsertEnvValue,
} from "../src/environment.js";
import { exitCodeFor, fail, ok, renderReport, skip, tally, warn } from "../src/report.js";
import { foreignPaths, renderMissionEngineUnit } from "../src/systemd.js";
import { applyPlan, planSetup } from "../src/setup.js";
import { runDoctor } from "../src/doctor.js";
import { hostAndPort, parseUnitShow, type Probes } from "../src/probes.js";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  return root;
}

const PAIR = generateKeyPairSync("ed25519");
const PRIVATE_PEM = PAIR.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = PAIR.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("installation location resolution", () => {
  it("traverses upwards to the workspace root", () => {
    const root = workspace();
    const nested = join(root, "services", "api", "src");
    mkdirSync(nested, { recursive: true });

    expect(findRepositoryRoot(nested)).toBe(root);
  });

  it("fails informatively when outside a valid installation", () => {
    const orphan = mkdtempSync(join(tmpdir(), "nexus-orphan-"));
    expect(() => findRepositoryRoot(orphan)).toThrow(/pnpm-workspace/);
  });

  it("derives all installation paths from root without hardcoding", () => {
    const paths = resolvePaths("/opt/nexus", "/home/someone");

    expect(paths.missionEngine).toBe("/opt/nexus/services/mission-engine");
    expect(paths.agentRunner).toBe("/opt/nexus/services/agent/dist/cli.js");
    expect(paths.publicKeyFile).toBe("/home/someone/.config/nexus/api-public.pem");
  });
});

describe(".env file parsing and manipulation", () => {
  it("reads variables while ignoring comments and blank lines", () => {
    const root = workspace();
    writeFileSync(
      join(root, ".env"),
      ["# comment", "", "NODE_ENV=development", "API_PORT=3000", "#DISABLED=1"].join("\n"),
    );

    expect(readEnvFile(join(root, ".env"))).toEqual({
      NODE_ENV: "development",
      API_PORT: "3000",
    });
  });

  it("restores escaped newlines inside quoted values", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), `AUTH_SIGNING_KEY="${PRIVATE_PEM.replace(/\n/g, "\\n")}"\n`);

    const reread = readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY ?? "";
    expect(reread).toContain("\n");
    expect(() => createPrivateKey(reread)).not.toThrow();
  });

  it("returns empty record when file is missing without throwing", () => {
    expect(readEnvFile(join(workspace(), "absent"))).toEqual({});
  });

  it("replaces existing variable without modifying unrelated entries", () => {
    const before = "NODE_ENV=development\nAPI_PORT=3000\n";
    const after = upsertEnvValue(before, "API_PORT", "4000");

    expect(after).toBe("NODE_ENV=development\nAPI_PORT=4000\n");
  });

  it("uncomments existing commented variable line in-place", () => {
    const after = upsertEnvValue("# AUTH_SIGNING_KEY=\n", "AUTH_SIGNING_KEY", "abc");

    expect(after).toBe("AUTH_SIGNING_KEY=abc\n");
    expect(after).not.toContain("#");
  });

  it("quotes multiline values", () => {
    const after = upsertEnvValue("", "AUTH_SIGNING_KEY", PRIVATE_PEM);

    expect(after).toContain('"');
    expect(after.split("\n")).toHaveLength(2);
  });

  it("distinguishes persistent key from absent key", () => {
    expect(hasPersistentSigningKey({ AUTH_SIGNING_KEY: PRIVATE_PEM })).toBe(true);
    expect(hasPersistentSigningKey({})).toBe(false);
    expect(hasPersistentSigningKey({ AUTH_SIGNING_KEY: "not-a-pem-key" })).toBe(false);
  });
});

describe("diagnostic report", () => {
  const groups = [
    {
      title: "Group",
      results: [ok("a", "healthy"), warn("b", "warning", "remedy"), skip("c", "skipped")],
    },
  ];

  it("tallies results by status", () => {
    expect(tally(groups)).toEqual({ ok: 1, warn: 1, fail: 0, skip: 1 });
  });

  it("only exits with failure on fail status", () => {
    expect(exitCodeFor(groups)).toBe(0);
    expect(exitCodeFor([{ title: "x", results: [fail("d", "broken")] }])).toBe(1);
  });

  it("displays actionable remedy on dedicated line", () => {
    const rendered = renderReport(groups);

    expect(rendered).toContain("→ remedy");
    expect(rendered).toContain("1 ok · 1 warning · 0 failed · 1 skipped");
  });
});

describe("systemd service unit generation", () => {
  const paths = resolvePaths("/opt/nexus", "/home/someone");
  const base = {
    paths,
    pnpmPath: "/usr/bin/pnpm",
    servicePath: "/usr/bin",
    apiUrl: "http://127.0.0.1:3000",
  };

  it("contains no paths outside the current installation root", () => {
    const unit = renderMissionEngineUnit(base);

    expect(unit).not.toContain("/home/alice/former-nexus");
    expect(unit).toContain("WorkingDirectory=/opt/nexus/services/mission-engine");
    expect(unit).toContain("ExecStartPre=/usr/bin/pnpm --dir /opt/nexus");
  });

  it("only enables inbound auth when public key is deployed", () => {
    expect(renderMissionEngineUnit(base)).toContain("INACTIVE");
    expect(renderMissionEngineUnit(base)).not.toContain("NEXUS_ENGINE_API_PUBLIC_KEY_FILE=");

    const secured = renderMissionEngineUnit({ ...base, publicKeyFile: "/key.pem" });
    expect(secured).toContain("Environment=NEXUS_ENGINE_API_PUBLIC_KEY_FILE=/key.pem");
  });

  it("detects paths belonging to relocated installation", () => {
    const stale = renderMissionEngineUnit({
      ...base,
      paths: resolvePaths("/old/location/nexus", "/home/someone"),
    });

    const strays = foreignPaths(stale, "/opt/nexus");
    expect(strays.length).toBeGreaterThan(0);
    expect(strays.some((path) => path.startsWith("/old/location"))).toBe(true);
  });

  it("does not flag legitimate system binaries", () => {
    expect(foreignPaths(renderMissionEngineUnit(base), "/opt/nexus")).toEqual([]);
  });
});

describe("nexus setup", () => {
  function setupIn(root: string, options: Partial<Parameters<typeof planSetup>[0]> = {}) {
    return planSetup({
      paths: resolvePaths(root, join(root, "home")),
      dryRun: false,
      rotateKeys: false,
      pnpmPath: "/usr/bin/pnpm",
      servicePath: "/usr/bin",
      ...options,
    });
  }

  it("generates signing key on clean install, idempotent on subsequent runs", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");

    applyPlan(setupIn(root));
    const first = readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY;
    expect(first).toContain("BEGIN PRIVATE KEY");

    const second = setupIn(root);
    applyPlan(second);
    expect(readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY).toBe(first);
    expect(second.actions.filter((action) => action.needed)).toHaveLength(0);
  });

  it("only rotates signing key on explicit request with warning", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");
    applyPlan(setupIn(root));
    const before = readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY;

    const rotation = setupIn(root, { rotateKeys: true });
    expect(rotation.warnings.join(" ")).toMatch(/sessions/);
    applyPlan(rotation);
    expect(readEnvFile(join(root, ".env")).AUTH_SIGNING_KEY).not.toBe(before);
  });

  it("restricts permissions of secrets file to owner", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n", { mode: 0o644 });

    applyPlan(setupIn(root));
    expect((statSync(join(root, ".env")).mode & 0o777).toString(8)).toBe("600");
  });

  it("deploys public key corresponding to persistent private key", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), `AUTH_SIGNING_KEY="${PRIVATE_PEM.replace(/\n/g, "\\n")}"\n`);

    const paths = resolvePaths(root, join(root, "home"));
    applyPlan(setupIn(root));

    expect(readFileSync(paths.publicKeyFile, "utf8").replace(/\s/g, "")).toBe(
      PUBLIC_PEM.replace(/\s/g, ""),
    );
  });

  it("writes systemd unit with installation paths", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");
    const paths = resolvePaths(root, join(root, "home"));

    applyPlan(setupIn(root));
    const unit = readFileSync(join(paths.systemdUserDir, "nexus-mission-engine.service"), "utf8");

    expect(unit).toContain(root);
    expect(foreignPaths(unit, root)).toEqual([]);
  });

  it("creates .env from template example when missing", () => {
    const root = workspace();
    writeFileSync(join(root, ".env.example"), "NODE_ENV=development\n");

    const plan = setupIn(root);
    expect(plan.actions[0]?.label).toContain("create .env");
    applyPlan(plan);
    expect(readEnvFile(join(root, ".env")).NODE_ENV).toBe("development");
  });

  it("creates local runtime configuration without tracking personal profiles", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");
    mkdirSync(join(root, "services", "agent", "config"), { recursive: true });
    mkdirSync(join(root, "services", "mission-engine", "config"), { recursive: true });
    writeFileSync(
      join(root, "services", "agent", "config", "profiles.example.json"),
      '{"profiles":{"example":{"command":"npx"}}}\n',
    );
    writeFileSync(
      join(root, "services", "mission-engine", "config", "profiles.example.json"),
      '{"example":"example"}\n',
    );
    writeFileSync(
      join(root, "services", "mission-engine", "config", "runtime-settings.example.json"),
      '{"max_attempts":3}\n',
    );

    const paths = resolvePaths(root, join(root, "home"));
    applyPlan(setupIn(root));

    expect(readFileSync(paths.agentRegistry, "utf8")).toContain('"example"');
    expect(readFileSync(paths.engineProfiles, "utf8")).toContain('"example"');
    expect(readFileSync(paths.engineRuntimeSettings, "utf8")).toContain('"max_attempts"');
    expect((statSync(paths.agentRegistry).mode & 0o777).toString(8)).toBe("600");
  });

  it("generates PostgreSQL URL with random password and warns caller", () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n");

    const plan = setupIn(root);
    applyPlan(plan);

    const url = readEnvFile(join(root, ".env")).DATABASE_URL ?? "";
    expect(url).toMatch(/^postgresql:\/\/nexus:.+@127\.0\.0\.1:15432\/nexus$/);
    expect(plan.warnings.join(" ")).toMatch(/docker compose/);
  });
});

describe("diagnostic probes", () => {
  it("applies protocol default ports", () => {
    expect(hostAndPort("postgresql://u:p@localhost/db")).toEqual({ host: "localhost", port: 5432 });
    expect(hostAndPort("redis://127.0.0.1")).toEqual({ host: "127.0.0.1", port: 6379 });
    expect(hostAndPort("https://example.test")).toEqual({ host: "example.test", port: 443 });
    expect(hostAndPort("http://127.0.0.1:18100")).toEqual({ host: "127.0.0.1", port: 18100 });
  });

  it("returns undefined for invalid URLs without throwing", () => {
    expect(hostAndPort("not a url")).toBeUndefined();
  });
});

describe("nexus doctor", () => {
  function probesFor(overrides: Partial<Probes> = {}): Probes {
    return {
      tcp: () => Promise.resolve(true),
      http: () => Promise.resolve({ status: 200, body: '{"profiles":["codex"]}' }),
      command: () => Promise.resolve(undefined),
      ...overrides,
    };
  }

  it("fails when .env is absent and points to fix", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor(),
      env: {},
    });

    const envCheck = groups[0]?.results[0];
    expect(envCheck?.status).toBe("fail");
    expect(envCheck?.fix).toContain("nexus setup");
  });

  it("flags ephemeral signing key as warning rather than failure", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor(),
      env: { NODE_ENV: "development" },
    });

    const security = groups.find((group) => group.title === "Security");
    const key = security?.results.find((result) => result.name === "signing key");
    expect(key?.status).toBe("warn");
    expect(key?.fix).toContain("nexus setup");
  });

  it("detects deployed public key that does not match signing key", async () => {
    const root = workspace();
    const paths = resolvePaths(root, join(root, "home"));
    mkdirSync(join(root, "home", ".config", "nexus"), { recursive: true });
    const other = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    writeFileSync(paths.publicKeyFile, other);

    const groups = await runDoctor({
      paths,
      probes: probesFor(),
      env: { NODE_ENV: "development", AUTH_SIGNING_KEY: PRIVATE_PEM },
    });

    const security = groups.find((group) => group.title === "Security");
    const deployed = security?.results.find((result) => result.name === "deployed public key");
    expect(deployed?.status).toBe("fail");
  });

  it("reports pending PostgreSQL migrations as failure", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor({
        command: (file, args) =>
          Promise.resolve(
            file === "pnpm" && args.includes("status")
              ? "2 migrations found. Following migrations have not yet been applied"
              : undefined,
          ),
      }),
      env: { NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@127.0.0.1:15432/nexus" },
    });

    const data = groups.find((group) => group.title === "Data and services");
    const migrations = data?.results.find((result) => result.name === "PostgreSQL migrations");
    expect(migrations?.status).toBe("fail");
    expect(migrations?.fix).toContain("migrate deploy");
  });

  it("reports missing systemd unit as warning without failing overall run", async () => {
    const root = workspace();
    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: probesFor(),
      env: { NODE_ENV: "development" },
    });

    const systemd = groups.find((group) => group.title === "Systemd services");
    expect(systemd?.results.every((result) => result.status !== "fail")).toBe(true);
  });
});

describe("systemd unit state parsing", () => {
  it("parses properties by key name rather than position", () => {
    const output = [
      "LoadState=loaded",
      "ActiveState=active",
      "FragmentPath=/home/someone/.config/systemd/user/nexus-mission-engine.service",
      "UnitFileState=enabled",
    ].join("\n");

    expect(parseUnitShow(output)).toEqual({
      installed: true,
      enabled: true,
      active: true,
      fragmentPath: "/home/someone/.config/systemd/user/nexus-mission-engine.service",
    });
  });

  it("yields empty state for unknown unit", () => {
    expect(parseUnitShow("LoadState=not-found\nActiveState=inactive\nFragmentPath=")).toEqual({
      installed: false,
      enabled: false,
      active: false,
      fragmentPath: undefined,
    });
  });
});

describe("portable systemd unit paths", () => {
  it("allows standard systemd specifiers", () => {
    const portable = [
      "[Service]",
      "Environment=XDG_CONFIG_HOME=%h/.local/share/nexus/browser-xdg/config",
      "ExecStart=/usr/bin/chromium --user-data-dir=%h/.local/share/nexus/browser-profile",
      "BindPaths=%h/.local/share/nexus/browser-profile",
    ].join("\n");

    expect(foreignPaths(portable, "/opt/nexus")).toEqual([]);
  });

  it("flags absolute paths from different installation directories", () => {
    const stale = "WorkingDirectory=/other/nexus/services/mission-engine";

    expect(foreignPaths(stale, "/opt/nexus")).toEqual(["/other/nexus/services/mission-engine"]);
  });
});

describe("secrets file permissions", () => {
  it("verifies permissions even in absence of persistent key", async () => {
    const root = workspace();
    writeFileSync(join(root, ".env"), "NODE_ENV=development\n", { mode: 0o644 });

    const groups = await runDoctor({
      paths: resolvePaths(root, join(root, "home")),
      probes: {
        tcp: () => Promise.resolve(true),
        http: () => Promise.resolve({ status: 200, body: "{}" }),
        command: () => Promise.resolve(undefined),
      },
      env: { NODE_ENV: "development" },
    });

    const security = groups.find((group) => group.title === "Security");
    const permissions = security?.results.find((result) => result.name === ".env permissions");
    expect(permissions?.status).toBe("warn");
    expect(permissions?.fix).toContain("chmod 600");
  });
});
