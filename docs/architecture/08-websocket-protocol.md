# 08 — WebSocket Protocol

## 1. Core Architecture Decisions

- **Single Connection** per client session, multiplexed across channels (`conversation:{id}`, `run:{id}`,
  `user:{id}`, `device:{id}`). Spawning a socket per run is an anti-pattern on mobile: drains battery
  and is vulnerable to mobile cellular drops.
- **Native WebSockets** (`ws`), avoiding Socket.IO: proprietary protocols offer no advantage here and
  complicate non-JS clients (Python/Rust workers) (→ [ADR-009](../adr/ADR-009-ws-protocol.md)).
- **Two Distinct Endpoints**: `/ws/client` (user interactive sessions) and `/ws/device` (Device Agents).
  Separating authentication mechanisms and message types avoids privilege confusion.
- **JSON Encoding** by default, MessagePack negotiable; raw audio payloads stream over binary frames.

## 2. Standard Envelope

Every frame, in both directions, follows a consistent schema:

```jsonc
{
  "v": 1, // Protocol major version; mismatch → close(4400)
  "id": "01J...", // ULID of the frame (client-side deduplication)
  "type": "agent.token",
  "ts": "2026-09-01T10:00:00.123Z",
  "seq": 42, // Monotonic sequence per channel; basis of replay
  "channel": "run:01J...",
  "payload": {},
}
```

A `z.discriminatedUnion('type', ...)` in `@nexus/contracts` defines the entire catalog; both client and
server parse frames on receipt. Unknown frame types are logged and ignored, never fatal: this allows
introducing new event types without breaking older mobile clients.

## 3. Connection Handshake

```
1. Client   WSS /ws/client?v=1  (Zero tokens in query parameters: avoids log leakage)
2. Server   Awaits first frame; 5-second grace period
3. Client   { type: "auth", payload: { accessToken } }
4. Server   { type: "connection.ready", payload: { sessionId, serverTime, limits, features } }
5. Client   { type: "subscribe", payload: { channels: ["conversation:X"], since: { "run:Y": 41 } } }
6. Server   Replays missed frames from Redis Stream, then transitions to real-time broadcast
```

`since` makes the protocol **resumable**: switching between Wi-Fi and cellular does not lose in-flight
tokens. Run events are retained for 15 minutes in a per-run Redis Stream.

## 4. Client → Server Messages

| Type                                         | Payload                                                      | Notes                             |
| -------------------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `auth`                                       | `{ accessToken }`                                            | Mandatory as initial frame        |
| `subscribe` / `unsubscribe`                  | `{ channels[], since? }`                                     | Authorization checked per channel |
| `message.send`                               | `{ conversationId, content, clientMessageId, attachments? }` | `clientMessageId` = idempotency   |
| `run.cancel`                                 | `{ runId, reason? }`                                         | Graceful cooperative abort        |
| `confirmation.respond`                       | `{ confirmationId, decision, remember?, nonce }`             | Mirrors REST API route            |
| `voice.start` / `voice.chunk` / `voice.stop` | Binary audio frames                                          | Streaming STT dictation           |
| `typing`                                     | `{ conversationId }`                                         | Cross-device presence indicators  |
| `ping`                                       | `{}`                                                         | Heartbeat ping, every 25s         |

## 5. Server → Client Messages

| Type                            | Payload                                                                  | Semantics                                     |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| `connection.ready`              | `{ sessionId, limits, features }`                                        | Emitted upon successful auth                  |
| `message.created`               | `Message`                                                                | Broadcast, including to other active devices  |
| `run.started`                   | `{ runId, mode, budget }`                                                | Run lifecycle kickoff                         |
| `run.status`                    | `{ runId, status, iteration }`                                           | State machine transition notifications        |
| `agent.thinking`                | `{ runId, label }`                                                       | Drives mobile UI progress animations          |
| `agent.plan`                    | `{ runId, steps[] }`                                                     | Live plan DAG updates                         |
| `agent.token`                   | `{ runId, messageId, delta, index }`                                     | Streamed text tokens; coalesced (§7)          |
| `agent.message`                 | `Message`                                                                | Final assistant message, persisted in DB      |
| `tool.started`                  | `{ execId, runId, tool, title, riskLevel, argsPreview }`                 | Redacted argument preview                     |
| `tool.progress`                 | `{ execId, pct?, label?, chunk?, screenshotUrl? }`                       | Browser screenshots, shell stdout chunks      |
| `tool.result`                   | `{ execId, ok, summary, artifacts[], durationMs }`                       | Final tool result                             |
| `confirmation.requested`        | `{ confirmationId, title, summary, diff?, riskLevel, expiresAt, nonce }` | Triggers prompt card + push notification      |
| `confirmation.resolved`         | `{ confirmationId, decision, by }`                                       | Dismisses prompt card across all user devices |
| `run.completed`                 | `{ runId, messageId, usage }`                                            | Terminal completion with token metrics        |
| `run.failed`                    | `{ runId, error: { code, userMessage } }`                                | Clean error format, never stack traces        |
| `run.cancelled` / `run.partial` | `{ runId, summary }`                                                     | Partial completion status                     |
| `device.status`                 | `{ deviceId, status }`                                                   | Device online/offline badges                  |
| `memory.updated`                | `{ memoryId, kind }`                                                     | Subtle notification of learned facts          |
| `error`                         | `{ code, message, retryable, correlationId }`                            | Protocol-level errors                         |
| `pong`                          | `{ serverTime }`                                                         | Heartbeat response                            |

## 6. Device Channel (`/ws/device`)

| Direction | Type                                 | Role                                                           |
| --------- | ------------------------------------ | -------------------------------------------------------------- |
| →         | `device.auth`                        | Ed25519 cryptographic challenge signature                      |
| ←         | `device.ready`                       | Policy acknowledgment and protocol version negotiation         |
| →         | `device.heartbeat`                   | Every 20s: system load, version, active running tasks          |
| ←         | `device.task.assign`                 | `{ taskId, tool, args, idemKey, deadline }`                    |
| →         | `device.task.accepted` / `.rejected` | Rejection with explanation (local policy denial, missing deps) |
| →         | `device.task.progress`               | stdout/stderr chunks and execution percentage                  |
| →         | `device.task.result`                 | `{ ok, output, exitCode, metrics }`                            |
| ←         | `device.task.cancel`                 | Cooperative task cancellation                                  |
| ←         | `device.policy.sync`                 | Server queries current active local policy (read-only)         |

The server **never** modifies local security policy over this channel. This is an invariant architectural constraint.

## 7. Backpressure, Token Coalescence, and Limits

- **Token Coalescence**: Deltas aggregate across ~50ms or 40-character windows. Emitting a frame per
  individual token causes unnecessary mobile CPU wakeups and battery drain for no perceived benefit.
- **Bounded Buffering**: If a client falls behind (`bufferedAmount` > 1 MB), we throttle gracefully —
  temporarily dropping high-frequency `agent.token` deltas while preserving lifecycle state events.
  The full response arrives in the final `agent.message`. Sacrificing streaming smoothness is acceptable;
  losing operational state is not.
- **Connection Limits**: 1 MB max frame payload, 20 messages/sec per connection, 5 concurrent connections per user.
- **Heartbeats**: Application ping every 25s, timeout after 60s. Backgrounded mobile clients close
  active sockets and rely on **push notifications** for confirmation prompts and completions.

## 8. WebSocket Close Codes

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 4400 | Incompatible protocol version → client upgrade required   |
| 4401 | Missing or invalid authentication token                   |
| 4403 | Unauthorized channel subscription attempt                 |
| 4408 | Authentication handshake timeout                          |
| 4429 | Rate limit exceeded                                       |
| 4500 | Server error → client reconnects with exponential backoff |

Clients reconnect using exponential backoff with jitter (1s → 30s), **except** on 4400 (fatal) and
4401 (triggers a token refresh cycle prior to one retry attempt).
