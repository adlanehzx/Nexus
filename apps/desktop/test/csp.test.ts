import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Content Security Policy and mode-based relaxations.
 *
 * Ensures CSP only allows https: and wss: in production, while permitting
 * loopback strictly in development mode.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

function html(): string {
  return readFileSync(path.join(ROOT, "index.html"), "utf8");
}

function connectSrc(source: string): string {
  const match = /connect-src ([^"]*)"/.exec(source);
  if (match === null) throw new Error("no connect-src directive");
  return match[1]!;
}

describe("shipped package CSP", () => {
  it("only allows https and wss to contact the core", () => {
    const directive = connectSrc(html());

    expect(directive).toContain("https:");
    expect(directive).toContain("wss:");
    expect(directive).not.toContain("http://localhost");
    expect(directive).not.toContain("ws://");
  });

  it("allows Tauri to communicate with its own backend", () => {
    const directive = connectSrc(html());

    expect(directive).toContain("ipc:");
    expect(directive).toContain("http://ipc.localhost");
  });

  it("disallows remote resources other than connection endpoints", () => {
    const source = html();

    expect(source).toContain("default-src 'self'");
    expect(source).not.toContain("script-src 'unsafe-eval'");
    expect(source).not.toContain("default-src *");
  });
});

describe("development relaxation", () => {
  /**
   * Replays Vite plugin transform without triggering a build.
   */
  function transform(source: string, mode: string): string {
    const LOCAL = [
      "http://localhost:*",
      "http://127.0.0.1:*",
      "ws://localhost:*",
      "ws://127.0.0.1:*",
    ].join(" ");

    if (mode === "production") return source;
    return source.replace(
      /connect-src ([^"]*)"/,
      (_m, value: string) => `connect-src ${value.trim()} ${LOCAL}"`,
    );
  }

  it("adds loopback outside production", () => {
    const directive = connectSrc(transform(html(), "development"));

    expect(directive).toContain("http://localhost:*");
    expect(directive).toContain("ws://127.0.0.1:*");
    expect(directive).toContain("https:");
  });

  it("does NOT open generic http:, even in development", () => {
    const directive = connectSrc(transform(html(), "development"));

    expect(directive.split(/\s+/)).not.toContain("http:");
    expect(directive.split(/\s+/)).not.toContain("ws:");
    expect(directive.split(/\s+/)).not.toContain("*");
  });

  it("does not modify anything in production", () => {
    expect(transform(html(), "production")).toBe(html());
  });
});

/**
 * Native shell configuration.
 */
describe("Tauri configuration", () => {
  const conf = JSON.parse(
    readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  ) as {
    version: string;
    app: { withGlobalTauri?: boolean; security: { csp: string; devCsp?: string } };
  };

  it("exposes __TAURI__ to the renderer", () => {
    expect(conf.app.withGlobalTauri).toBe(true);
  });

  it("maintains a production CSP without plaintext", () => {
    const csp = conf.app.security.csp;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("wss:");
    expect(csp).not.toContain("http://localhost");
    expect(csp).not.toContain("ws://");
    expect(csp).toContain("ipc:");
  });

  it("only opens loopback via devCsp", () => {
    const dev = conf.app.security.devCsp;
    expect(dev).toBeDefined();

    expect(dev).toContain("http://localhost:*");
    expect(dev).toContain("ws://127.0.0.1:*");
    expect(dev?.split(/\s+/)).not.toContain("http:");
    expect(dev?.split(/\s+/)).not.toContain("*");
  });

  it("shares the same version as the package and Rust crate", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const cargo = readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8");
    const cargoVersion = /^version = "([^"]+)"/m.exec(cargo)?.[1];

    expect(conf.version).toBe(pkg.version);
    expect(cargoVersion).toBe(pkg.version);
  });

  it("declares the shell build tool", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.scripts.tauri).toBeDefined();
    expect(pkg.devDependencies["@tauri-apps/cli"]).toMatch(/^2\./);
  });
});
