import { describe, expect, it } from "vitest";
import {
  InsecureBackendUrlError,
  backendHttpUrl,
  clientSocketUrl,
  isLocalHost,
} from "../src/transport.js";

/**
 * Adresses du cœur.
 *
 * Le canal client porte le **jeton d'accès de l'utilisateur** dans sa première
 * trame. Un `NEXUS_URL` mal renseigné en `http://` le mettait en clair sur le
 * réseau, sans que rien ne le signale.
 *
 * Les trois exécutants refusent déjà une adresse distante en clair. Ces tests
 * fixent la même règle du côté qui porte les jetons.
 */

describe("adresse du cœur", () => {
  it("accepte https et normalise la barre finale", () => {
    expect(backendHttpUrl("https://nexus.exemple.fr")).toBe("https://nexus.exemple.fr");
    expect(backendHttpUrl("https://nexus.exemple.fr/")).toBe("https://nexus.exemple.fr");
  });

  it("refuse une adresse distante en clair", () => {
    // Le point de sécurité. Sans ce refus, la poignée de main envoie le jeton
    // d'accès en clair sur le Wi-Fi d'un hôtel.
    expect(() => backendHttpUrl("http://nexus.exemple.fr")).toThrow(InsecureBackendUrlError);
    expect(() => backendHttpUrl("http://192.168.1.20:3000")).toThrow(InsecureBackendUrlError);
  });

  it("tolère la boucle locale et l'hôte de l'émulateur", () => {
    // Sans cette exception, on ne peut plus développer. Aucune de ces adresses
    // ne quitte la machine.
    expect(backendHttpUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(backendHttpUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(backendHttpUrl("http://10.0.2.2:3000")).toBe("http://10.0.2.2:3000");

    expect(isLocalHost("LOCALHOST")).toBe(true);
    expect(isLocalHost("nexus.exemple.fr")).toBe(false);
  });

  it("refuse ce qui n'est pas une URL, ou un protocole inattendu", () => {
    expect(() => backendHttpUrl("nexus.exemple.fr")).toThrow(InsecureBackendUrlError);
    expect(() => backendHttpUrl("file:///etc/passwd")).toThrow(InsecureBackendUrlError);
    expect(() => backendHttpUrl("javascript:alert(1)")).toThrow(InsecureBackendUrlError);
  });

  it("nomme l'URL fautive sans exposer de secret", () => {
    try {
      backendHttpUrl("http://nexus.exemple.fr");
      expect.unreachable();
    } catch (error) {
      // L'adresse n'est pas un secret ; sans elle, le message oblige à deviner
      // quelle variable est en cause.
      expect((error as Error).message).toContain("http://nexus.exemple.fr");
    }
  });
});

describe("canal temps réel", () => {
  it("dérive wss depuis https", () => {
    expect(clientSocketUrl("https://nexus.exemple.fr")).toBe("wss://nexus.exemple.fr/ws/client");
  });

  it("dérive ws depuis la boucle locale", () => {
    expect(clientSocketUrl("http://localhost:3000")).toBe("ws://localhost:3000/ws/client");
  });

  it("refuse un canal distant en clair", () => {
    expect(() => clientSocketUrl("http://nexus.exemple.fr")).toThrow(InsecureBackendUrlError);
  });

  it("n'ajoute pas deux fois le chemin du canal", () => {
    expect(clientSocketUrl("https://nexus.exemple.fr/ws/client")).toBe(
      "wss://nexus.exemple.fr/ws/client",
    );
  });
});
