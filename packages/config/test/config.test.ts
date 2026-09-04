import { describe, expect, it } from "vitest";
import { ConfigurationError } from "@nexus/shared";
import { parseConfig } from "../src/load.js";

/** Environnement minimal valide : uniquement les variables sans défaut. */
const minimalEnv = {
  DATABASE_URL: "postgresql://nexus:pwd@localhost:5432/nexus",
  REDIS_URL: "redis://localhost:6379",
} satisfies NodeJS.ProcessEnv;

describe("parseConfig", () => {
  it("accepte un environnement minimal et applique les valeurs par défaut", () => {
    const config = parseConfig(minimalEnv);

    expect(config.NODE_ENV).toBe("development");
    expect(config.API_PORT).toBe(3000);
    expect(config.API_HOST).toBe("0.0.0.0");
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(config.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("convertit les nombres transmis en chaînes par l'environnement", () => {
    const config = parseConfig({ ...minimalEnv, API_PORT: "8080" });

    expect(config.API_PORT).toBe(8080);
    expect(typeof config.API_PORT).toBe("number");
  });

  it("découpe CORS_ORIGINS et supprime les espaces", () => {
    const config = parseConfig({
      ...minimalEnv,
      CORS_ORIGINS: "http://a.test , http://b.test,, http://c.test",
    });

    expect(config.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test", "http://c.test"]);
  });

  it("refuse une DATABASE_URL qui n'est pas du PostgreSQL", () => {
    expect(() => parseConfig({ ...minimalEnv, DATABASE_URL: "mysql://localhost:3306/db" })).toThrow(
      ConfigurationError,
    );
  });

  it("refuse une variable obligatoire manquante", () => {
    expect(() => parseConfig({ REDIS_URL: minimalEnv.REDIS_URL })).toThrow(ConfigurationError);
  });

  it("refuse un port hors plage", () => {
    expect(() => parseConfig({ ...minimalEnv, API_PORT: "70000" })).toThrow(ConfigurationError);
  });

  it("refuse le joker CORS en production", () => {
    expect(() => parseConfig({ ...minimalEnv, NODE_ENV: "production", CORS_ORIGINS: "*" })).toThrow(
      ConfigurationError,
    );
  });

  it("tolère le joker CORS en développement", () => {
    expect(parseConfig({ ...minimalEnv, CORS_ORIGINS: "*" }).CORS_ORIGINS).toEqual(["*"]);
  });

  it("nomme la variable fautive dans le message d'erreur", () => {
    // Un échec de configuration doit dire QUOI corriger : c'est la seule
    // information utile à 3 h du matin.
    try {
      parseConfig({ ...minimalEnv, LOG_LEVEL: "verbeux" });
      expect.unreachable("parseConfig aurait dû lever");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).message).toContain("LOG_LEVEL");
    }
  });
});
