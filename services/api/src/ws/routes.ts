import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { uuidv7 } from "@nexus/shared";
import { WsCloseCode, parseClientHello } from "@nexus/protocol";

/**
 * Transport WebSocket des deux canaux.
 *
 * Ce module est **uniquement du transport**. Toute la logique vit déjà dans
 * `ClientChannel` et `WorkerChannel`, et elle y est éprouvée sans réseau ; ce
 * fichier ouvre des sockets, décode des trames, et appelle. S'il contenait une
 * décision d'autorisation, cette décision ne serait vérifiable qu'en ouvrant un
 * port — c'est exactement ce qu'on ne veut pas.
 *
 * Deux chemins, séparés jusqu'au bout :
 *
 *     /ws/client   jeton d'accès + appareil        → ClientChannel
 *     /ws/worker   challenge signé par la machine  → WorkerChannel
 *
 * Le portable Windows emprunte **les deux**, avec deux secrets différents et
 * depuis deux processus différents : l'interface tient les jetons de
 * l'utilisateur, le démon tient la clé privée de la machine. Aucun des deux ne
 * peut prendre la place de l'autre, et c'est cette séparation qui fait qu'une
 * fenêtre compromise ne devient pas une exécution de commande.
 */

/** Un poste qui n'a rien prouvé au bout de ce délai est fermé. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Rythme des ping applicatifs. Une socket morte se détecte par le silence. */
const KEEPALIVE_INTERVAL_MS = 30_000;

/** 256 Ko : au-delà, ce n'est plus une commande, c'est un transfert. */
const MAX_PAYLOAD_BYTES = 262_144;

export interface WebSocketRoutesOptions {
  /** Origines acceptées pour une connexion de navigateur. */
  allowedOrigins: readonly string[];
  /** Délai de poignée de main. Raccourci dans les tests, qui n'attendent pas. */
  handshakeTimeoutMs?: number;
}

export async function websocketRoutes(
  app: FastifyInstance,
  options: WebSocketRoutesOptions,
): Promise<void> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;

  await app.register(websocket, {
    options: {
      maxPayload: MAX_PAYLOAD_BYTES,
      // `Origin` ne remplace pas l'authentification — le jeton et la signature
      // s'en chargent — mais il coûte trois lignes et ferme le détournement
      // WebSocket inter-site avant même la poignée de main. Une origine absente
      // est acceptée : le démon worker n'est pas un navigateur et n'en envoie
      // pas.
      verifyClient: ({ origin }, done) => {
        if (origin === undefined || options.allowedOrigins.includes(origin)) {
          done(true);
          return;
        }
        done(false, 403, "origine refusée");
      },
    },
  });

  clientSocketRoute(app, handshakeTimeoutMs);
  workerSocketRoute(app, handshakeTimeoutMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Canal client
// ─────────────────────────────────────────────────────────────────────────────

function clientSocketRoute(app: FastifyInstance, handshakeTimeoutMs: number): void {
  app.get("/ws/client", { websocket: true }, (socket: WebSocket, request) => {
    const log = request.log;
    let context: Awaited<ReturnType<typeof app.clientChannel.authenticate>> | undefined;

    // Une socket ouverte qui ne se présente pas consomme un descripteur et une
    // entrée de table pour rien. Le minuteur ferme le silence.
    const handshake = setTimeout(() => {
      if (context === undefined) socket.close(WsCloseCode.AUTH_TIMEOUT, "poignée de main absente");
    }, handshakeTimeoutMs);

    const keepalive = setInterval(() => {
      socket.ping();
    }, KEEPALIVE_INTERVAL_MS);

    const shutdown = () => {
      clearTimeout(handshake);
      clearInterval(keepalive);
      if (context !== undefined) app.clientChannel.detach(context.deviceId);
    };

    // Les trames sont traitées **dans l'ordre, une à la fois**.
    //
    // Sans cette file, un client qui envoie sa poignée de main puis sa première
    // demande dans la même boucle d'événements verrait la seconde arriver
    // pendant que l'authentification est encore en vol : la session n'existe pas
    // encore, la trame est prise pour une seconde poignée de main, et la
    // connexion est fermée. C'est exactement ce que fait `RealtimeClient` au
    // démarrage — le cas normal, pas un cas limite.
    const queue = serialize();

    socket.on("message", (data) => {
      const frame = decode(data);
      if (frame === undefined) return;

      queue(async () => {
        if (context === undefined) {
          context = await openClientSession(app, socket, frame, log);
          if (context !== undefined) clearTimeout(handshake);
          return;
        }

        await app.clientChannel.handle(context, frame);
      });
    });

    socket.on("close", shutdown);
    socket.on("error", (cause) => {
      log.warn({ err: cause }, "socket client en erreur");
      shutdown();
    });
  });
}

/**
 * Ouvre une session client à partir de la première trame.
 *
 * Rend `undefined` et ferme si la trame n'est pas une poignée de main valide.
 * Le code 4401 est ce qui permet au client de comprendre qu'il doit faire
 * tourner son jeton plutôt que de reconnecter éternellement avec le même.
 */
async function openClientSession(
  app: FastifyInstance,
  socket: WebSocket,
  frame: unknown,
  log: FastifyInstance["log"],
): Promise<Awaited<ReturnType<typeof app.clientChannel.authenticate>> | undefined> {
  const hello = parseClientHello(frame);
  if (hello === undefined) {
    socket.close(WsCloseCode.UNAUTHENTICATED, "poignée de main attendue");
    return undefined;
  }

  try {
    const context = await app.clientChannel.authenticate(hello);
    await app.clientChannel.attach(context, {
      send: (data) => {
        socket.send(data);
      },
      close: (code, reason) => {
        socket.close(code, reason);
      },
    });

    // Le jeton n'apparaît nulle part : seul l'appareil est journalisé.
    log.info({ deviceId: context.deviceId, userId: context.userId }, "client connecté");
    return context;
  } catch (cause) {
    log.warn({ err: cause, deviceId: hello.deviceId }, "poignée de main client refusée");
    const isDeviceError = cause instanceof Error && cause.message.includes("Appareil");
    const code = isDeviceError ? WsCloseCode.FORBIDDEN_CHANNEL : WsCloseCode.UNAUTHENTICATED;
    socket.close(code, "authentification refusée");
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canal worker
// ─────────────────────────────────────────────────────────────────────────────

function workerSocketRoute(app: FastifyInstance, handshakeTimeoutMs: number): void {
  app.get("/ws/worker", { websocket: true }, (socket: WebSocket, request) => {
    const log = request.log;
    const connectionId = uuidv7();

    app.workerChannel.open(connectionId, {
      send: (data) => {
        socket.send(data);
      },
      close: (code, reason) => {
        socket.close(code, reason);
      },
      ...(request.ip === undefined ? {} : { remoteAddress: request.ip }),
    });

    // Même règle que pour les clients : une machine qui ne signe pas le
    // challenge dans les temps n'obtient pas de sursis.
    const handshake = setTimeout(() => {
      if (!app.workerChannel.isAuthenticated(connectionId)) {
        socket.close(WsCloseCode.AUTH_TIMEOUT, "authentification absente");
      }
    }, handshakeTimeoutMs);

    const keepalive = setInterval(() => {
      socket.ping();
    }, KEEPALIVE_INTERVAL_MS);

    const shutdown = (reason: string) => {
      clearTimeout(handshake);
      clearInterval(keepalive);
      void app.workerChannel.close(connectionId, reason);
    };

    // Même file que côté client : `worker.hello`, `worker.authenticate` et
    // `worker.register` s'enchaînent, et chacun suppose que le précédent a
    // abouti.
    const queue = serialize();

    socket.on("message", (data) => {
      const frame = decode(data);
      if (frame === undefined) return;
      queue(() => app.workerChannel.handle(connectionId, frame));
    });

    socket.on("close", () => {
      shutdown("socket fermée");
    });
    socket.on("error", (cause) => {
      log.warn({ err: cause }, "socket worker en erreur");
      shutdown("socket en erreur");
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * File d'exécution séquentielle.
 *
 * Rend une fonction qui enchaîne les tâches les unes après les autres. Une tâche
 * qui échoue ne casse pas la chaîne : la suivante s'exécute quand même, sinon
 * une seule trame mal formée figerait la connexion pour de bon.
 */
function serialize(): (task: () => Promise<void>) => void {
  let chain: Promise<void> = Promise.resolve();

  return (task) => {
    chain = chain.then(task).catch(() => undefined);
  };
}

/**
 * Décode une trame.
 *
 * Rend `undefined` sur ce qui n'est pas du JSON. On ne ferme pas pour autant :
 * les canaux savent déjà ignorer ce qu'ils ne comprennent pas, et fermer sur
 * une trame illisible offrirait un déni de service à une seule socket bruyante.
 */
function decode(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}
