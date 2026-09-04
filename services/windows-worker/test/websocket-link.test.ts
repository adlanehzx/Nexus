import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Envelope } from "@nexus/protocol";
import { WebSocketLink, toSocketUrl } from "../src/connection/websocket-link.js";
import { WorkerConfigurationError } from "../src/errors.js";
import { defaultStatePath, publicStateOf } from "../src/runtime/state-file.js";

/**
 * Le canal réel du démon.
 *
 * Un vrai serveur WebSocket sur un port éphémère, en face du vrai `ws` client.
 * Le cœur n'est pas de la partie : ce qui est éprouvé ici, c'est le transport —
 * connexion sortante, cadrage, fermeture — et rien du protocole, qui l'est
 * ailleurs sans réseau.
 */

let server: WebSocketServer;
let url: string;
let sockets: ServerSocket[] = [];
let received: unknown[] = [];

function envelope(type: string): Envelope {
  return { v: 1, id: "e-1", type, ts: new Date().toISOString(), payload: {} };
}

beforeEach(async () => {
  received = [];
  sockets = [];

  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data: Buffer) => {
      received.push(JSON.parse(data.toString("utf8")));
    });
  });

  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("pas d'adresse");
  url = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("connexion sortante", () => {
  it("ouvre un canal vers le cœur", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await link.connect();

    expect(link.state).toBe("open");
    await link.close("fin de test");
  });

  it("n'écoute sur rien", () => {
    // La forme du port le dit déjà — il y a `connect`, il n'y a pas `listen` —
    // mais l'écrire ici fixe l'intention : ce démon n'est joignable depuis
    // aucun réseau, ce qui supprime toute la surface d'un service exposé.
    const link = new WebSocketLink({ backendUrl: url });

    expect("listen" in link).toBe(false);
    expect(link.url).toBe(url.replace("http", "ws") + "/ws/worker");
  });

  it("rejette quand le cœur est injoignable", async () => {
    const link = new WebSocketLink({ backendUrl: "http://127.0.0.1:1", connectTimeoutMs: 500 });

    await expect(link.connect()).rejects.toThrow();
    expect(link.state).toBe("closed");
  });
});

describe("échange de trames", () => {
  it("envoie une enveloppe telle quelle", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await link.connect();

    await link.send(envelope("worker.hello"));
    await until(() => received.length > 0);

    expect(received[0]).toMatchObject({ v: 1, type: "worker.hello" });
    await link.close("fin");
  });

  it("livre les trames descendantes au runtime", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    const recues: unknown[] = [];
    link.onMessage((frame) => recues.push(frame));

    await link.connect();
    await until(() => sockets.length > 0);
    sockets[0]?.send(JSON.stringify(envelope("worker.challenge")));

    await until(() => recues.length > 0);
    expect(recues[0]).toMatchObject({ type: "worker.challenge" });
    await link.close("fin");
  });

  it("ignore une trame illisible sans fermer", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    const recues: unknown[] = [];
    link.onMessage((frame) => recues.push(frame));

    await link.connect();
    await until(() => sockets.length > 0);
    sockets[0]?.send("pas du json");
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => recues.length > 0);
    expect(recues).toHaveLength(1);
    expect(link.state).toBe("open");
    await link.close("fin");
  });

  it("refuse d'envoyer sur un canal fermé", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await expect(link.send(envelope("worker.hello"))).rejects.toThrow(/fermé/);
  });
});

describe("fermeture", () => {
  it("signale une coupure subie", async () => {
    // La reprise appartient au runtime : le canal se contente de dire qu'il
    // n'est plus là, et le runtime décide quand réessayer.
    const link = new WebSocketLink({ backendUrl: url });
    let raison: string | undefined;
    link.onClose((cause) => {
      raison = cause;
    });

    await link.connect();
    await until(() => sockets.length > 0);
    sockets[0]?.close(1011, "le cœur redémarre");

    await until(() => raison !== undefined);
    expect(raison).toContain("redémarre");
    expect(link.state).toBe("closed");
  });

  it("une fermeture demandée est idempotente", async () => {
    const link = new WebSocketLink({ backendUrl: url });
    await link.connect();

    await link.close("première");
    await expect(link.close("seconde")).resolves.toBeUndefined();
  });
});

describe("adresse du cœur", () => {
  it("passe en wss pour une adresse https", () => {
    expect(toSocketUrl("https://nexus.exemple.fr", "/ws/worker")).toBe(
      "wss://nexus.exemple.fr/ws/worker",
    );
  });

  it("tolère le clair en local seulement", () => {
    expect(toSocketUrl("http://localhost:3000", "/ws/worker")).toBe(
      "ws://localhost:3000/ws/worker",
    );
  });

  it("refuse une adresse distante en clair", () => {
    // Le challenge signé authentifie la machine ; il ne chiffre pas la suite.
    // En clair, les consignes d'exécution envoyées à ce poste seraient lisibles
    // et modifiables par qui se trouve sur le chemin.
    expect(() => toSocketUrl("http://nexus.exemple.fr", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });

  it("refuse ce qui n'est pas une URL", () => {
    expect(() => toSocketUrl("nexus.exemple.fr", "/ws/worker")).toThrow(WorkerConfigurationError);
  });

  it("conserve un préfixe de chemin", () => {
    // Un cœur derrière un reverse proxy peut vivre sous un sous-chemin.
    expect(toSocketUrl("https://exemple.fr/nexus/", "/ws/worker")).toBe(
      "wss://exemple.fr/nexus/ws/worker",
    );
  });
});

describe("état public du démon", () => {
  it("ne publie qu'un identifiant, jamais un secret", () => {
    const etat = publicStateOf({
      deviceId: "device-portable",
      platform: "WINDOWS",
      workerVersion: "0.1.0",
      now: new Date("2026-09-02T12:00:00.000Z"),
    });

    // Ce fichier est lisible par l'utilisateur de la machine. Tout ce qui s'y
    // trouve est donc, en pratique, public.
    expect(Object.keys(etat).sort()).toEqual([
      "deviceId",
      "platform",
      "startedAt",
      "workerVersion",
    ]);

    const serialise = JSON.stringify(etat);
    for (const interdit of ["credential", "privateKey", "allowedPaths", "backendUrl", "token"]) {
      expect(serialise).not.toContain(interdit);
    }
  });

  it("se range sous ProgramData", () => {
    const chemin = defaultStatePath({ ProgramData: "C:\\ProgramData" });

    // `ProgramData` et non le profil utilisateur : le démon tourne en service,
    // l'interface dans une session interactive, et ils ne partagent aucun
    // dossier personnel.
    expect(chemin).toContain("ProgramData");
    expect(chemin).toContain("device.json");
  });
});

/** Attend une condition, en laissant tourner la boucle d'événements. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > limite) throw new Error("condition non atteinte");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
