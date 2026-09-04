import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Envelope } from "@nexus/protocol";
import { WorkerConfigurationError } from "@nexus/worker-core";
import {
  AndroidWebSocketLink,
  toAndroidSocketUrl,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src/connection/websocket-link.js";

/**
 * Le canal réel du téléphone.
 *
 * Un vrai serveur WebSocket sur un port éphémère, en face du `WebSocket` global
 * — celui de Node ici, celui de React Native sur l'appareil. Les deux
 * implémentent la même norme, et c'est précisément pourquoi le canal est écrit
 * contre elle plutôt que contre `node:ws` : ce qui est éprouvé ici est le code
 * qui tournera sur le Redmi.
 *
 * **Ce que ce fichier ne couvre pas** : la pile TLS d'Android, l'épinglage par
 * `network_security_config.xml`, et le comportement du `WebSocket` d'OkHttp
 * quand le téléphone bascule du Wi-Fi vers les données mobiles. Ce sont des
 * observations d'appareil, pas des tests unitaires — le README les liste.
 */

let server: WebSocketServer;
let url: string;
let sockets: ServerSocket[] = [];
let received: unknown[] = [];

function envelope(type: string): Envelope {
  return { v: 1, id: "e-1", type, ts: new Date().toISOString(), payload: {} };
}

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`jamais atteint : ${label}`);
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
  for (const socket of sockets) socket.terminate();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connexion
// ─────────────────────────────────────────────────────────────────────────────

describe("connexion sortante", () => {
  it("ouvre un canal vers le cœur", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await link.connect();

    expect(link.state).toBe("open");
    await link.close("fin de test");
  });

  it("n'écoute sur rien", () => {
    // La forme du port le dit déjà — il y a `connect`, il n'y a pas `listen` —
    // mais l'écrire ici fixe l'intention. Un téléphone qui exposerait un service
    // serait joignable depuis tout réseau Wi-Fi auquel il se connecte.
    const link = new AndroidWebSocketLink({ backendUrl: url });

    expect("listen" in link).toBe(false);
    expect(link.url).toBe(`${url.replace("http", "ws")}/ws/worker`);
  });

  it("rejette quand le cœur est injoignable", async () => {
    const link = new AndroidWebSocketLink({
      backendUrl: "http://127.0.0.1:1",
      connectTimeoutMs: 1_000,
    });

    await expect(link.connect()).rejects.toThrow();
    expect(link.state).toBe("closed");
  });

  it("abandonne quand la connexion n'aboutit jamais", async () => {
    // Le cas propre au mobile : un portail captif accepte la connexion TCP puis
    // ne répond plus. Sans échéance, la promesse resterait en suspens et la
    // reprise du runtime — qui est le mécanisme prévu — ne partirait jamais.
    const link = new AndroidWebSocketLink({
      backendUrl: url,
      connectTimeoutMs: 40,
      socketFactory: muetteFactory(),
    });

    await expect(link.connect()).rejects.toThrow(/délai/);
    expect(link.state).toBe("closed");
  });

  it("traite une fabrique qui lève comme un échec de connexion", async () => {
    // Sur un environnement sans `WebSocket`, on rejette proprement plutôt que de
    // laisser une exception remonter jusqu'à l'hôte React Native, qui la
    // traiterait en plantage d'application.
    const link = new AndroidWebSocketLink({
      backendUrl: url,
      socketFactory: () => {
        throw new Error("aucune implémentation");
      },
    });

    await expect(link.connect()).rejects.toThrow(/aucune implémentation/);
    expect(link.state).toBe("closed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trames
// ─────────────────────────────────────────────────────────────────────────────

describe("échange de trames", () => {
  it("envoie une enveloppe telle quelle", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await link.connect();

    await link.send(envelope("worker.hello"));
    await until(() => received.length > 0, "trame reçue par le serveur");

    expect(received[0]).toMatchObject({ v: 1, type: "worker.hello" });
    await link.close("fin");
  });

  it("livre les trames descendantes au runtime", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const recues: unknown[] = [];
    link.onMessage((frame) => recues.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "socket serveur");
    sockets[0]?.send(JSON.stringify(envelope("worker.challenge")));

    await until(() => recues.length > 0, "trame descendante");
    expect(recues[0]).toMatchObject({ type: "worker.challenge" });
    await link.close("fin");
  });

  it("ignore une trame illisible sans fermer le canal", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const recues: unknown[] = [];
    link.onMessage((frame) => recues.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "socket serveur");
    sockets[0]?.send("pas du json");
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => recues.length > 0, "trame valide");
    expect(recues).toHaveLength(1);
    expect(link.state).toBe("open");
    await link.close("fin");
  });

  it("écarte une trame démesurée", async () => {
    // Plafond côté téléphone : un cœur compromis, ou un mandataire hostile, ne
    // doit pas pouvoir épuiser la mémoire de l'application avec une seule trame.
    const link = new AndroidWebSocketLink({ backendUrl: url, maxFrameBytes: 256 });
    const recues: unknown[] = [];
    link.onMessage((frame) => recues.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "socket serveur");

    const enorme = JSON.stringify({ ...envelope("worker.task"), bourrage: "x".repeat(2_000) });
    sockets[0]?.send(enorme);
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => recues.length > 0, "trame valide");
    expect(recues).toHaveLength(1);
    expect(recues[0]).toMatchObject({ type: "worker.session" });
    await link.close("fin");
  });

  it("écarte une trame binaire", async () => {
    // Le protocole NEXUS est en JSON. Accepter du binaire ouvrirait un second
    // cadrage que rien ne lit — et donc rien ne valide.
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const recues: unknown[] = [];
    link.onMessage((frame) => recues.push(frame));

    await link.connect();
    await until(() => sockets.length > 0, "socket serveur");
    sockets[0]?.send(Buffer.from(JSON.stringify(envelope("worker.task"))));
    sockets[0]?.send(JSON.stringify(envelope("worker.session")));

    await until(() => recues.length > 0, "trame valide");
    expect(recues).toHaveLength(1);
    expect(recues[0]).toMatchObject({ type: "worker.session" });
    await link.close("fin");
  });

  it("refuse d'envoyer sur un canal fermé", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await expect(link.send(envelope("worker.hello"))).rejects.toThrow(/canal fermé/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fermeture et reprise
// ─────────────────────────────────────────────────────────────────────────────

describe("fermeture", () => {
  it("signale une coupure subie, pour que le runtime reprenne", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const raisons: string[] = [];
    link.onClose((reason) => raisons.push(reason));

    await link.connect();
    await until(() => sockets.length > 0, "socket serveur");
    sockets[0]?.close(1011, "cœur redémarré");

    await until(() => raisons.length > 0, "coupure signalée");
    expect(raisons[0]).toContain("cœur redémarré");
    expect(link.state).toBe("closed");
  });

  it("ne signale pas une fermeture que nous avons demandée", async () => {
    // Sinon un arrêt volontaire relancerait immédiatement la reprise, et le
    // worker se reconnecterait juste après qu'on lui a demandé de s'arrêter.
    const link = new AndroidWebSocketLink({ backendUrl: url });
    const raisons: string[] = [];
    link.onClose((reason) => raisons.push(reason));

    await link.connect();
    await link.close("arrêt demandé");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(raisons).toEqual([]);
    expect(link.state).toBe("closed");
  });

  it("se laisse rouvrir après une coupure", async () => {
    // C'est ce que fait la reprise du runtime : le même objet `WorkerLink` est
    // reconnecté, il n'en construit pas un nouveau.
    const link = new AndroidWebSocketLink({ backendUrl: url });

    await link.connect();
    await until(() => sockets.length > 0, "première socket");
    // `terminate` et non `close` : c'est la coupure brutale du réseau mobile,
    // sans trame de fermeture — le cas réel quand le téléphone perd le Wi-Fi.
    sockets[0]?.terminate();
    await until(() => link.state === "closed", "canal fermé");

    await link.connect();
    expect(link.state).toBe("open");

    await link.send(envelope("worker.hello"));
    await until(() => received.length > 0, "trame après reprise");
    await link.close("fin");
  });

  it("fermer deux fois ne lève pas", async () => {
    const link = new AndroidWebSocketLink({ backendUrl: url });
    await link.connect();

    await link.close("une fois");
    await expect(link.close("deux fois")).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// URL — la règle du texte clair
// ─────────────────────────────────────────────────────────────────────────────

describe("toAndroidSocketUrl", () => {
  it("passe en wss pour une adresse distante", () => {
    expect(toAndroidSocketUrl("https://nexus.exemple.fr", "/ws/worker")).toBe(
      "wss://nexus.exemple.fr/ws/worker",
    );
  });

  it("refuse une adresse distante en clair", () => {
    // Le point de sécurité : un téléphone se connecte depuis n'importe quel
    // réseau, y compris un point d'accès public. Le jeton de session ne peut pas
    // y transiter en clair.
    expect(() => toAndroidSocketUrl("http://nexus.exemple.fr", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
    expect(() => toAndroidSocketUrl("ws://192.168.1.20:3000", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });

  it("tolère la boucle locale et l'hôte de l'émulateur", () => {
    // `10.0.2.2` est la machine de développement vue depuis l'émulateur ; elle
    // n'est routable depuis aucun réseau.
    expect(toAndroidSocketUrl("http://localhost:3000", "/ws/worker")).toBe(
      "ws://localhost:3000/ws/worker",
    );
    expect(toAndroidSocketUrl("http://10.0.2.2:3000", "/ws/worker")).toBe(
      "ws://10.0.2.2:3000/ws/worker",
    );
  });

  it("n'ajoute pas deux fois le chemin du canal", () => {
    // Le fichier d'exemple donne l'URL complète ; la concaténer aveuglément
    // donnerait `/ws/worker/ws/worker`, et la connexion serait refusée avec un
    // message qui n'expliquerait rien.
    expect(toAndroidSocketUrl("wss://nexus.exemple.fr/ws/worker", "/ws/worker")).toBe(
      "wss://nexus.exemple.fr/ws/worker",
    );
  });

  it("refuse une URL invalide ou un protocole inconnu", () => {
    expect(() => toAndroidSocketUrl("pas une url", "/ws/worker")).toThrow(WorkerConfigurationError);
    expect(() => toAndroidSocketUrl("file:///etc/passwd", "/ws/worker")).toThrow(
      WorkerConfigurationError,
    );
  });
});

/** Une socket qui accepte tout et ne rappelle jamais — le portail captif. */
function muetteFactory(): WebSocketFactory {
  return (): WebSocketLike => ({
    readyState: 0,
    send: () => undefined,
    close: () => undefined,
    addEventListener: () => undefined,
  });
}
