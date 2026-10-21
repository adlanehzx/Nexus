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
    expect(config.METRICS_ENABLED).toBe(true);
    expect(config.METRICS_PORT).toBe(9464);
    expect(config.MODEL_PRICING_JSON).toEqual({});
    expect(config.MEMORY_EMBEDDING_BACKEND).toBe("neural");
    expect(config.MEMORY_EMBEDDING_LOCAL_ONLY).toBe(false);
    // Hors production, les trois coquilles locales sont ouvertes d'office —
    // l'API, la fenêtre Vite du client de bureau, le serveur Expo du mobile —
    // et les origines Tauri s'y ajoutent : sans elles, le client de bureau
    // empaqueté est refusé à la poignée de main WebSocket.
    expect(config.CORS_ORIGINS).toEqual([
      "http://localhost:3000",
      "http://localhost:5273",
      "http://localhost:8081",
      "http://tauri.localhost",
      "tauri://localhost",
    ]);
  });

  it("valide le moteur local d'embeddings", () => {
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

  it("valide les répertoires persistants des conteneurs", () => {
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

  it("n'ouvre aucune origine de développement en production", () => {
    // Le défaut permissif est une commodité de développement, et il ne doit pas
    // suivre en production : les origines réellement servies s'y déclarent au
    // déploiement. Seules les origines Tauri subsistent — elles ne désignent
    // aucun serveur joignable, mais l'application installée elle-même.
    const config = parseConfig({ ...minimalEnv, NODE_ENV: "production" });

    expect(config.CORS_ORIGINS).toEqual(["http://tauri.localhost", "tauri://localhost"]);
  });

  it("ne dépend pas de l'environnement du processus qui appelle", () => {
    // Une même entrée doit produire une même sortie. Le défaut se décidait sur
    // `process.env.NODE_ENV` et non sur la valeur lue, ce qui rendait le
    // résultat différent selon le processus appelant.
    const avant = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(parseConfig(minimalEnv).CORS_ORIGINS).toContain("http://localhost:3000");
    } finally {
      if (avant === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = avant;
    }
  });

  it("convertit les nombres transmis en chaînes par l'environnement", () => {
    const config = parseConfig({ ...minimalEnv, API_PORT: "8080" });

    expect(config.API_PORT).toBe(8080);
    expect(typeof config.API_PORT).toBe("number");
  });

  it("valide la configuration d'observabilité et les tarifs équivalents", () => {
    const config = parseConfig({
      ...minimalEnv,
      METRICS_ENABLED: "false",
      METRICS_PORT: "19464",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
      MODEL_PRICING_JSON: JSON.stringify({
        "modele-local": { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      }),
    });

    expect(config.METRICS_ENABLED).toBe(false);
    expect(config.METRICS_PORT).toBe(19_464);
    expect(config.MODEL_PRICING_JSON["modele-local"]?.outputPerMillionUsd).toBe(2);
    expect(() => parseConfig({ ...minimalEnv, MODEL_PRICING_JSON: "pas-du-json" })).toThrow(
      ConfigurationError,
    );
  });

  it("accepte Mission Control en boucle locale et refuse HTTP distant", () => {
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

  it("traite une URL Mission Control vide comme une intégration désactivée", () => {
    expect(
      parseConfig({ ...minimalEnv, MISSION_CONTROL_URL: "" }).MISSION_CONTROL_URL,
    ).toBeUndefined();
  });

  it("valide SearXNG local, interne ou HTTPS et traite une valeur vide comme désactivée", () => {
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

  it("découpe CORS_ORIGINS et supprime les espaces", () => {
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
    expect(parseConfig({ ...minimalEnv, CORS_ORIGINS: "*" }).CORS_ORIGINS).toEqual([
      "*",
      "http://tauri.localhost",
      "tauri://localhost",
    ]);
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

  it("accepte toujours les origines de la coquille Tauri", () => {
    // Le défaut de la phase précédente : le client Windows empaqueté recevait un
    // 403 sur `/ws/client` parce que son origine n'était déclarée nulle part, et
    // qu'aucun déploiement ne pouvait la deviner.
    for (const cors of ["http://localhost:3000", "https://nexus.exemple.fr"]) {
      const config = parseConfig({ ...minimalEnv, CORS_ORIGINS: cors });
      expect(config.CORS_ORIGINS).toContain("http://tauri.localhost");
      expect(config.CORS_ORIGINS).toContain("tauri://localhost");
    }
  });

  it("n'ajoute pas deux fois une origine Tauri déjà déclarée", () => {
    const config = parseConfig({
      ...minimalEnv,
      CORS_ORIGINS: "tauri://localhost,http://localhost:3000",
    });

    expect(config.CORS_ORIGINS.filter((o) => o === "tauri://localhost")).toHaveLength(1);
  });

  it("n'élargit rien d'autre : une origine arbitraire reste absente", () => {
    // La vérification d'origine doit rester entière. Ajouter Tauri ne doit pas
    // ouvrir la porte à un site tiers.
    const config = parseConfig({ ...minimalEnv, CORS_ORIGINS: "http://localhost:3000" });

    expect(config.CORS_ORIGINS).not.toContain("https://attaquant.test");
    expect(config.CORS_ORIGINS).not.toContain("*");
  });
});
