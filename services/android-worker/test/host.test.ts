import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Android host — Kotlin scaffolding for worker.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const KOTLIN = path.join(ROOT, "android", "src", "main", "kotlin", "fr", "nexus", "worker");

function kotlin(name: string): string {
  return readFileSync(path.join(KOTLIN, `${name}.kt`), "utf8");
}

/** Strips comments: tests inspect code, not comments. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function manifest(): string {
  return readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8").replace(
    /<!--[\s\S]*?-->/g,
    "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Declared manifest classes exist
// ─────────────────────────────────────────────────────────────────────────────

describe("manifest consistency", () => {
  it("each declared class actually exists", () => {
    const declared = [...manifest().matchAll(/android:name="\.([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1]!,
    );

    expect(declared.length).toBeGreaterThan(0);

    for (const name of declared) {
      expect(existsSync(path.join(KOTLIN, `${name}.kt`)), `${name}.kt missing`).toBe(true);
    }
  });

  it("Gradle project exists and declares namespace outside manifest", () => {
    const build = readFileSync(path.join(ROOT, "android", "app", "build.gradle.kts"), "utf8");

    expect(build).toContain('namespace = "fr.nexus.worker"');
    expect(manifest()).not.toContain("package=");
  });

  it("does not request permission to draw over other applications", () => {
    expect(manifest()).toContain('android:name="android.permission.SYSTEM_ALERT_WINDOW"');
    expect(manifest()).toContain('tools:node="remove"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Foreground service is not a second executor
// ─────────────────────────────────────────────────────────────────────────────

describe("foreground service", () => {
  it("exposes no binding channel", () => {
    const source = stripComments(kotlin("WorkerForegroundService"));
    expect(source).toMatch(/override fun onBind\([^)]*\): IBinder\? = null/);
  });

  it("is not exported", () => {
    expect(manifest()).toMatch(
      /<service[\s\S]{0,200}android:name="\.WorkerForegroundService"[\s\S]{0,200}android:exported="false"/,
    );
  });

  it("executes no capabilities", () => {
    const source = stripComments(kotlin("WorkerForegroundService"));

    expect(source).not.toMatch(/CapabilityRegistry|executeCapability|performClick|takeScreenshot/);
    expect(source).not.toMatch(/NexusAccessibilityService/);
    expect(source).not.toMatch(/Runtime\.getRuntime|ProcessBuilder|exec\(/);
  });

  it("recognizes only start and stop", () => {
    const source = stripComments(kotlin("WorkerForegroundService"));

    const actions = [...source.matchAll(/const val ACTION_[A-Z_]+ =/g)];
    expect(actions).toHaveLength(2);

    expect(source).not.toMatch(/getStringExtra|getBundleExtra|getSerializableExtra/);
  });

  it("displays no task content in its notification", () => {
    const source = stripComments(kotlin("WorkerForegroundService"));
    expect(source).toContain("VISIBILITY_SECRET");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot receiver
// ─────────────────────────────────────────────────────────────────────────────

describe("boot receiver", () => {
  it("checks received action", () => {
    const source = stripComments(kotlin("BootReceiver"));
    expect(source).toContain("intent.action != Intent.ACTION_BOOT_COMPLETED");
  });

  it("only starts the service", () => {
    const source = stripComments(kotlin("BootReceiver"));

    expect(source).toContain("WorkerForegroundService.start");
    expect(source).not.toMatch(/NexusAccessibilityService|NexusWorkerModule|performClick|openApp/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Native module registration
// ─────────────────────────────────────────────────────────────────────────────

describe("native surface", () => {
  it("registers only one module", () => {
    const source = stripComments(kotlin("NexusWorkerPackage"));

    expect(source).toContain("listOf(NexusWorkerModule(reactContext))");
    expect(source).toContain("emptyList()");
  });

  it("does not use autolinking", () => {
    const application = stripComments(kotlin("NexusWorkerApplication"));

    expect(application).toContain("MainReactPackage()");
    expect(application).toContain("NexusWorkerPackage()");

    expect(application).not.toContain("PackageList");

    const build = readFileSync(path.join(ROOT, "android", "app", "build.gradle.kts"), "utf8");
    expect(build).not.toContain("autolinkLibrariesWithApp");
  });

  it("activity executes no capabilities", () => {
    const source = stripComments(kotlin("WorkerActivity"));
    expect(source).not.toMatch(/NexusAccessibilityService|NexusWorkerModule|openApp|performClick/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No secrets versioned in build files
// ─────────────────────────────────────────────────────────────────────────────

describe("no secrets versioned", () => {
  const gradle = () =>
    [
      path.join(ROOT, "android", "app", "build.gradle.kts"),
      path.join(ROOT, "android", "build.gradle.kts"),
      path.join(ROOT, "android", "settings.gradle.kts"),
      path.join(ROOT, "android", "gradle.properties"),
    ].map((file) => ({ file, content: readFileSync(file, "utf8") }));

  it("no literal signing credentials", () => {
    for (const { file, content } of gradle()) {
      expect(content, file).not.toMatch(
        /(storePassword|keyPassword|storeFile|keyAlias)\s*=\s*"[^"]/,
      );
      expect(content, file).not.toMatch(/^[A-Za-z_]*(?:KEYSTORE|KEY)_PASSWORD\s*=/m);
    }
  });

  it("signing configuration comes from environment only", () => {
    const app = gradle().find((entry) => entry.file.endsWith(path.join("app", "build.gradle.kts")));
    expect(app).toBeDefined();
    const content = app?.content ?? "";

    for (const variable of [
      "NEXUS_KEYSTORE_PATH",
      "NEXUS_KEYSTORE_PASSWORD",
      "NEXUS_KEY_ALIAS",
      "NEXUS_KEY_PASSWORD",
    ]) {
      expect(content, variable).toContain(`System.getenv("${variable}")`);
    }

    expect(content).toMatch(/signingConfig\s*=\s*if\s*\(signingReady\)/);
  });

  it("embedded settings file contains only key alias", () => {
    const config = JSON.parse(readFileSync(path.join(ROOT, "nexus.config.json"), "utf8")) as Record<
      string,
      string
    >;

    expect(config.DEVICE_KEY_ALIAS).toBe("nexus.device.key");

    for (const [key, value] of Object.entries(config)) {
      expect(key, "no variable should contain a secret").not.toMatch(
        /SECRET|TOKEN|PASSWORD|PRIVATE_KEY/i,
      );
      expect(String(value)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });
});
