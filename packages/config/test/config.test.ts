import { describe, expect, it } from "vitest";
import { ConfigurationError } from "@nexus/shared";
import { parseConfig } from "../src/load.js";

/** Minimal valid environment: only required variables without defaults. */
const minimalEnv = {
  DATABASE_URL: "postgresql://nexus:pwd@localhost:5432/nexus",
  REDIS_URL: "redis://localhost:6379",
} satisfies NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("accepts a minimal environment and applies default values", () => {
    const config = parseConfig(minimalEnv);

    expect(config.NODE_ENV).toBe("development");
    expect(config.API_PORT).toBe(3000);
    expect(config.API_HOST).toBe("0.0.0.0");
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(config.METRICS_ENABLED).toBe(true);
    expect(config.METRICS_PORT).toBe(9464);
    expect(config.MODEL_PRICING_JSON).toEqual({});
    expect(config.MEMORY_EMBEDDING_BACKEND).toBe("neural");
    expect(config.MEMORY_EMBEDDING_LOCAL_ONLY).toBe(false);
    // Outside production, local shells are open by default —
    // the API, desktop Vite window, mobile Expo server —
    // and Tauri origins are added automatically.
    expect(config.CORS_ORIGINS).toEqual([
      "http://localhost:3000",
      "http://localhost:5273",
      "http://localhost:8081",
      "http://tauri.localhost",
      "tauri://localhost",
    ]);
  });

  it("validates local embedding engine", () => {
    const config = parseConfig({
      ...minimalEnv,
      MEMORY_EMBEDDING_BACKEND: "hash",
      MEMORY_EMBEDDING_LOCAL_ONLY: "true",
      MEMORY_EMBEDDING_CACHE_DIR: "/tmp/nexus-models",
    });

    expect(config.MEMORY_EMBEDDING_BACKEND).toBe("hash");
    expect(config.MEMORY_EMBEDDING_LOCAL_ONLY).toBe(true);
    expect(config.MEMORY_EMBEDDING_CACHE_DIR).toBe("/tmp/nexus-models");
    expect(() => parseConfig({ ...minimalEnv, MEMORY_EMBEDDING_BACKEND: "remote" })).toThrow(
      ConfigurationError,
    );
  });

  it("validates persistent container directories", () => {
    const config = parseConfig({
      ...minimalEnv,
      NEXUS_RUNTIME_CONFIG_DIR: "/var/lib/nexus/runtime-config",
      NEXUS_BROWSER_ARTIFACTS_DIR: "/var/lib/nexus/artifacts/browser",
      NEXUS_OBSERVABILITY_DIR: "/var/lib/nexus/observability",
    });
    expect(config.NEXUS_RUNTIME_CONFIG_DIR).toBe("/var/lib/nexus/runtime-config");
    expect(() => parseConfig({ ...minimalEnv, NEXUS_RUNTIME_CONFIG_DIR: "./config" })).toThrow(
      ConfigurationError,
    );
  });

  it("does not open development origins in production", () => {
    // Permissive defaults are a dev convenience and must not carry into prod.
    // Only Tauri origins persist.
    const config = parseConfig({ ...minimalEnv, NODE_ENV: "production" });

    expect(config.CORS_ORIGINS).toEqual(["http://tauri.localhost", "tauri://localhost"]);
  });

  it("does not depend on the calling process environment", () => {
    // Same input must produce same output regardless of process.env.
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(parseConfig(minimalEnv).CORS_ORIGINS).toContain("http://localhost:3000");
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  it("converts numeric strings from environment to numbers", () => {
    const config = parseConfig({ ...minimalEnv, API_PORT: "8080" });

    expect(config.API_PORT).toBe(8080);
    expect(typeof config.API_PORT).toBe("number");
  });

  it("validates observability configuration and equivalent pricing", () => {
    const config = parseConfig({
      ...minimalEnv,
      METRICS_ENABLED: "false",
      METRICS_PORT: "19464",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
      MODEL_PRICING_JSON: JSON.stringify({
        "local-model": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      }),
    });

    expect(config.METRICS_ENABLED).toBe(false);
    expect(config.METRICS_PORT).toBe(19_464);
    expect(config.MODEL_PRICING_JSON["local-model"]?.outputPerMillionUsd).toBe(2);
    expect(() => parseConfig({ ...minimalEnv, MODEL_PRICING_JSON: "not-json" })).toThrow(
      ConfigurationError,
    );
  });

  it("accepts Mission Control on loopback and rejects remote HTTP", () => {
    expect(
      parseConfig({ ...minimalEnv, MISSION_CONTROL_URL: "http://127.0.0.1:18100" })
        .MISSION_CONTROL_URL,
    ).toBe("http://127.0.0.1:18100");
    expect(() =>
      parseConfig({ ...minimalEnv, MISSION_CONTROL_URL: "http://example.org:18100" }),
    ).toThrow(ConfigurationError);
    expect(
      parseConfig({ ...minimalEnv, MISSION_CONTROL_URL: "https://mission.example.org" })
        .MISSION_CONTROL_URL,
    ).toBe("https://mission.example.org");
  });

  it("treats empty Mission Control URL as disabled integration", () => {
    expect(
      parseConfig({ ...minimalEnv, MISSION_CONTROL_URL: "" }).MISSION_CONTROL_URL,
    ).toBeUndefined();
  });

  it("validates SearXNG local, internal, or HTTPS and treats empty as disabled", () => {
    expect(parseConfig({ ...minimalEnv, SEARXNG_URL: "http://127.0.0.1:8080" }).SEARXNG_URL).toBe(
      "http://127.0.0.1:8080",
    );
    expect(parseConfig({ ...minimalEnv, SEARXNG_URL: "http://searxng:8080" }).SEARXNG_URL).toBe(
      "http://searxng:8080",
    );
    expect(
      parseConfig({ ...minimalEnv, SEARXNG_URL: "https://search.example.org" }).SEARXNG_URL,
    ).toBe("https://search.example.org");
    expect(parseConfig({ ...minimalEnv, SEARXNG_URL: "" }).SEARXNG_URL).toBeUndefined();
    expect(() => parseConfig({ ...minimalEnv, SEARXNG_URL: "http://search.example.org" })).toThrow(
      ConfigurationError,
    );
  });

  it("splits CORS_ORIGINS and trims whitespace", () => {
    const config = parseConfig({
      ...minimalEnv,
      CORS_ORIGINS: "http://a.test , http://b.test,, http://c.test",
    });

    expect(config.CORS_ORIGINS).toEqual([
      "http://a.test",
      "http://b.test",
      "http://c.test",
      "http://tauri.localhost",
      "tauri://localhost",
    ]);
  });

  it("rejects non-PostgreSQL DATABASE_URL", () => {
    expect(() => parseConfig({ ...minimalEnv, DATABASE_URL: "mysql://localhost:3306/db" })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects missing required variable", () => {
    expect(() => parseConfig({ REDIS_URL: minimalEnv.REDIS_URL })).toThrow(ConfigurationError);
  });

  it("rejects out of range port", () => {
    expect(() => parseConfig({ ...minimalEnv, API_PORT: "70000" })).toThrow(ConfigurationError);
  });

  it("rejects CORS wildcard in production", () => {
    expect(() => parseConfig({ ...minimalEnv, NODE_ENV: "production", CORS_ORIGINS: "*" })).toThrow(
      ConfigurationError,
    );
  });

  it("allows CORS wildcard in development", () => {
    expect(parseConfig({ ...minimalEnv, CORS_ORIGINS: "*" }).CORS_ORIGINS).toEqual([
      "*",
      "http://tauri.localhost",
      "tauri://localhost",
    ]);
  });

  it("identifies faulty variable in error message", () => {
    try {
      parseConfig({ ...minimalEnv, LOG_LEVEL: "verbose" });
      expect.unreachable("parseConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).message).toContain("LOG_LEVEL");
    }
  });

  it("always accepts Tauri shell origins", () => {
    for (const cors of ["http://localhost:3000", "https://nexus.example.org"]) {
      const config = parseConfig({ ...minimalEnv, CORS_ORIGINS: cors });
      expect(config.CORS_ORIGINS).toContain("http://tauri.localhost");
      expect(config.CORS_ORIGINS).toContain("tauri://localhost");
    }
  });

  it("does not duplicate Tauri origin if already declared", () => {
    const config = parseConfig({
      ...minimalEnv,
      CORS_ORIGINS: "tauri://localhost,http://localhost:3000",
    });

    expect(config.CORS_ORIGINS.filter((o) => o === "tauri://localhost")).toHaveLength(1);
  });

  it("does not broaden anything else: arbitrary origin remains absent", () => {
    const config = parseConfig({ ...minimalEnv, CORS_ORIGINS: "http://localhost:3000" });

    expect(config.CORS_ORIGINS).not.toContain("https://attacker.test");
    expect(config.CORS_ORIGINS).not.toContain("*");
  });
});
