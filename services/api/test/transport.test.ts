import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  CLIENT_HELLO,
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
  WORKER_MESSAGE,
  WsCloseCode,
  clientEnvelope,
  workerEnvelope,
} from "@nexus/protocol";
import {
  createAccount,
  listeningApi,
  registerDevice,
  signNonce,
  type Account,
  type ListeningApi,
  type RegisteredDevice,
} from "./harness.js";

/**
 * Le transport WebSocket, sur un vrai port.
 *
 * Tout le reste de la suite passe par `app.inject()` ou par un branchement
 * direct sur les canaux — délibérément, parce que c'est là que vit la logique.
 * Ce fichier est l'exception : il ouvre un port, s'y connecte avec `ws`, et
 * vérifie ce qu'aucun double ne peut vérifier — la mise à niveau HTTP, les codes
 * de fermeture, le cadrage des trames.
 *
 * Sans ce fichier, l'affirmation « le portable se connecte au cœur » resterait
 * une inférence.
 */

let api: ListeningApi;
let account: Account;
let portable: RegisteredDevice;

let sequence = 0;

function envelope(type: string, payload: unknown, requestId?: string) {
  sequence += 1;
  return JSON.stringify(
    clientEnvelope(type as never, payload as never, {
      id: `c-${String(sequence)}`,
      at: new Date(),
      requestId,
    }),
  );
}

function workerFrame(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return JSON.stringify(
    workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
      id: `w-${String(sequence)}`,
      at: new Date(),
    }),
  );
}

/** Ouvre une socket et attend son ouverture. */
function open(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, headers === undefined ? undefined : { headers });
    socket.once("open", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Attend la première trame d'un type donné. */
function waitFor(socket: WebSocket, type: string, timeoutMs = 3_000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`aucune trame « ${type} » en ${String(timeoutMs)} ms`));
    }, timeoutMs);

    function onMessage(data: unknown) {
      const frame = JSON.parse(String(data)) as Envelope;
      if (frame.type !== type) return;

      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    }

    socket.on("message", onMessage);
  });
}

interface Envelope {
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

/** Attend la fermeture et rend son code. */
function waitClose(socket: WebSocket, timeoutMs = 3_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("la socket n'a pas été fermée"));
    }, timeoutMs);

    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

beforeEach(async () => {
  api = await listeningApi();
  account = await createAccount(api.harness);
  portable = await registerDevice(api.harness, account, {
    name: "Portable Windows",
    role: "BOTH",
    permissions: ["filesystem.read"],
  });
});

afterEach(async () => {
  await api.close();
});

describe("canal client sur le fil", () => {
  it("ouvre une session sur une poignée de main valide", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);

    socket.send(
      envelope(CLIENT_HELLO, {
        accessToken: account.accessToken,
        deviceId: portable.device.id,
      }),
    );

    // La preuve que la session est ouverte : une demande obtient son accusé.
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "r1"));
    const ack = await waitFor(socket, SERVER_TO_CLIENT.ack);

    expect(ack.requestId).toBe("r1");
    expect(ack.payload.ok).toBe(true);
    socket.close();
  });

  it("ferme en 4401 quand le jeton est refusé", async () => {
    // Le code compte : le cœur client le distingue d'une coupure réseau et fait
    // tourner son jeton avant de réessayer, au lieu de marteler indéfiniment.
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(
      envelope(CLIENT_HELLO, { accessToken: "jeton-inventé", deviceId: portable.device.id }),
    );

    expect(await waitClose(socket)).toBe(WsCloseCode.UNAUTHENTICATED);
  });

  it("ferme quand la première trame n'est pas une poignée de main", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "r1"));

    expect(await waitClose(socket)).toBe(WsCloseCode.UNAUTHENTICATED);
  });

  it("ferme une socket muette", async () => {
    // Une connexion ouverte qui ne se présente jamais consomme un descripteur
    // et une entrée de table. Le délai est raccourci ici ; en production il est
    // de dix secondes.
    const socket = await open(`${api.wsUrl}/ws/client`);

    expect(await waitClose(socket)).toBe(WsCloseCode.AUTH_TIMEOUT);
  });

  it("ignore une trame illisible sans fermer", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(
      envelope(CLIENT_HELLO, {
        accessToken: account.accessToken,
        deviceId: portable.device.id,
      }),
    );

    socket.send("ceci n'est pas du json");
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: true }, "r2"));

    const ack = await waitFor(socket, SERVER_TO_CLIENT.ack);
    expect(ack.requestId).toBe("r2");
    socket.close();
  });

  it("refuse une origine inconnue avant la poignée de main", async () => {
    // Le jeton reste la vraie garde — un site tiers n'en a pas. Mais refuser
    // l'origine ferme le détournement inter-site avant même que la socket ne
    // s'ouvre, ce qui coûte trois lignes.
    await expect(
      open(`${api.wsUrl}/ws/client`, { origin: "https://site-malveillant.example" }),
    ).rejects.toThrow();
  });

  it("accepte une origine déclarée", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`, { origin: "http://localhost:3000" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

describe("canal worker sur le fil", () => {
  it("mène la poignée de main signée de bout en bout", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);

    socket.send(
      workerFrame("hello", {
        deviceId: portable.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = await waitFor(socket, WORKER_MESSAGE.challenge);
    const nonce = String(challenge.payload.nonce);

    socket.send(
      workerFrame("authenticate", {
        deviceId: portable.device.id,
        nonce,
        signature: signNonce(portable.privateKeyPem, nonce),
        capabilities: ["filesystem.read"],
        requestId: "auth-1",
        timestamp: new Date().toISOString(),
      }),
    );

    const session = await waitFor(socket, WORKER_MESSAGE.session);
    expect(session.payload.sessionId).toBeTruthy();

    expect(api.harness.services.gateway.isConnected(portable.device.id)).toBe(true);
    socket.close();
  });

  it("ferme sur une signature invalide", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);
    socket.send(
      workerFrame("hello", {
        deviceId: portable.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = await waitFor(socket, WORKER_MESSAGE.challenge);

    socket.send(
      workerFrame("authenticate", {
        deviceId: portable.device.id,
        nonce: String(challenge.payload.nonce),
        signature: Buffer.from("pas une signature").toString("base64"),
        capabilities: [],
        requestId: "auth-2",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(await waitClose(socket)).toBe(4401);
  });

  it("ferme une machine qui ne s'authentifie pas", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);

    expect(await waitClose(socket)).toBe(WsCloseCode.AUTH_TIMEOUT);
  });

  it("libère l'exécutant quand la socket tombe", async () => {
    const socket = await open(`${api.wsUrl}/ws/worker`);
    socket.send(
      workerFrame("hello", {
        deviceId: portable.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = await waitFor(socket, WORKER_MESSAGE.challenge);
    const nonce = String(challenge.payload.nonce);

    socket.send(
      workerFrame("authenticate", {
        deviceId: portable.device.id,
        nonce,
        signature: signNonce(portable.privateKeyPem, nonce),
        capabilities: ["filesystem.read"],
        requestId: "auth-3",
        timestamp: new Date().toISOString(),
      }),
    );
    await waitFor(socket, WORKER_MESSAGE.session);

    socket.close();
    // Sans détachement, le coordinateur attendrait le délai complet de chaque
    // étape en vol avant de comprendre que la machine a disparu.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(api.harness.services.gateway.isConnected(portable.device.id)).toBe(false);
  });
});

describe("cloisonnement sur le fil", () => {
  it("un client ne peut pas émettre une trame du canal worker", async () => {
    const socket = await open(`${api.wsUrl}/ws/client`);
    socket.send(
      envelope(CLIENT_HELLO, {
        accessToken: account.accessToken,
        deviceId: portable.device.id,
      }),
    );

    // Un `worker.task_result` forgé ferait croire au cœur qu'une étape a
    // réussi. Le canal client ne connaît pas ce type : il l'ignore, et la
    // demande légitime qui suit obtient bien son accusé.
    socket.send(
      JSON.stringify(
        workerEnvelope(
          WORKER_MESSAGE.taskResult,
          {
            taskId: "t1",
            stepId: "s1",
            ok: true,
            result: {},
            sensitiveResult: false,
            error: null,
            durationMs: 1,
          },
          { id: "forge-1", at: new Date() },
        ),
      ),
    );
    socket.send(envelope(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "r3"));

    const ack = await waitFor(socket, SERVER_TO_CLIENT.ack);
    expect(ack.requestId).toBe("r3");
    socket.close();
  });
});
