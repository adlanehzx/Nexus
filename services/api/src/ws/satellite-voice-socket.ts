import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { satelliteHelloSchema } from "../services/domotique/satellite-voice.js";

/**
 * `/ws/satellite` — ESP32 voice channel (protocol v1).
 *
 * The device proves itself with the same per-device token as the HTTP
 * heartbeat (`SatelliteService.authenticate`, SHA-256 digest comparison),
 * sent in the first frame (`hello`). Until then, nothing is accepted: a
 * binary frame before `hello` closes the socket. Text frames are JSON
 * control messages; binary frames are raw PCM s16le 16 kHz mono microphone
 * audio, only kept while a turn is listening.
 */

const AUTH_FAILED = 4401;
const PROTOCOL_ERROR = 4400;

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function satelliteVoiceSocketRoute(app: FastifyInstance, handshakeTimeoutMs: number): void {
  app.get("/ws/satellite", { websocket: true }, (socket: WebSocket, request) => {
    const gateway = app.services.satelliteVoice;
    let deviceId: string | undefined;
    const sink = {
      sendJson: (message: Record<string, unknown>) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      sendAudio: (chunk: Uint8Array) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
      },
    };

    const handshake = setTimeout(() => {
      if (deviceId === undefined) socket.close(AUTH_FAILED, "missing hello");
    }, handshakeTimeoutMs);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (deviceId === undefined) {
        if (isBinary) {
          socket.close(PROTOCOL_ERROR, "hello expected");
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(Buffer.from(toBytes(data)).toString("utf8"));
        } catch {
          socket.close(PROTOCOL_ERROR, "invalid json");
          return;
        }
        const hello = satelliteHelloSchema.safeParse(frame);
        if (
          !hello.success ||
          !app.satellites.authenticate(hello.data.deviceId, `Bearer ${hello.data.token}`)
        ) {
          // Same answer for unknown device and wrong token: no enumeration.
          request.log.warn({ event: "satellite.voice.auth_failed" }, "satellite voice auth failed");
          socket.close(AUTH_FAILED, "unauthorized");
          return;
        }
        clearTimeout(handshake);
        deviceId = hello.data.deviceId;
        gateway.attach(hello.data, sink);
        request.log.info(
          {
            event: "satellite.voice.connected",
            deviceId,
            speaker: hello.data.audio.speaker !== undefined,
          },
          "satellite voice connected",
        );
        return;
      }
      if (isBinary) {
        gateway.audio(deviceId, toBytes(data));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(Buffer.from(toBytes(data)).toString("utf8"));
      } catch {
        return;
      }
      if (!gateway.control(deviceId, frame)) {
        sink.sendJson({ v: 1, type: "error", code: "UNKNOWN_FRAME", message: "Unknown frame." });
      }
    });

    socket.on("close", () => {
      clearTimeout(handshake);
      if (deviceId !== undefined) gateway.detach(deviceId, sink);
    });
  });
}
