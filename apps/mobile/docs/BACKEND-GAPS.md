# Mobile: what the core does not provide yet

The mobile client consumes only existing routes. Everything below was checked against the code of
`services/api` and, where marked, against a running instance. Each entry states what the app does
**today**, so nothing is presented as working when it is not. The app adopts these contracts without
a release if the shape below is kept, unless noted.

Owner: backend. Status as of branch `feat/mobile-finalization`.

## Priority 1: blocks a stated objective

### 13. The realtime socket refuses the mobile app's `Origin`

Verified on an Android emulator against a running core: `GET /ws/client` answers 403 unless the
core's own address is listed in `CORS_ORIGINS`. React Native always sends an `Origin` header built
from the socket's address (`http://host:port` or `https://host`). On Android it can be replaced but
not removed (`WebSocketModule.getDefaultOrigin`). `services/api/src/ws/routes.ts` accepts only a
missing origin or a listed one. Without realtime the app has no live state, no confirmations and no
action mode.

**Today:** the app states which origin to allow and keeps retrying. Listing the core's public
address in `CORS_ORIGINS` is a complete workaround, verified on the emulator. It belongs in the
deployment configuration of any instance that serves mobile clients.

**Contract:** in `verifyClient`, also accept an `Origin` whose host and port equal the request's
`Host` header, and keep rejecting every other unlisted origin. A same-origin socket is not a
cross-site hijack, so the protection is unchanged. `verifyClient` receives `req` for this.

### 1. Reply streaming

`SERVER_TO_CLIENT.messageDelta` exists, and the client store renders it, but
`EVENT_TO_CLIENT_MESSAGE` (`packages/protocol/src/client.ts`) maps no event to it and nothing emits
it. `tool.*` frames are unmapped as well. `POST /agent-core/runs` answers only when the run ends.

**Today:** the app shows a "working" state, then the full answer. No fake typing effect.

**Contract:** forward agent-core events to the client channel for the conversation's owner:

```
message.delta  { conversationId, messageId, delta, done }
tool.started   { runId, callId, tool, summary, riskLevel }
tool.progress  { runId, callId, percent, label }
tool.completed { runId, callId, tool, ok, summary, durationMs }
```

`messageId` must be the id later returned by `GET /conversations/:id/messages`, so history replaces
the streamed copy instead of duplicating it.

### 2. `agent.started` emission, to interrupt a run from the chat

The frame exists in the protocol, but no code emits it. The agent route returns the `runId` only at
the end, so a client cannot address a run in progress.

**Today:** the app polls `GET /dashboard/runs?limit=10` every 3 s during a run, looking for the
conversation. This is **administrator-only**: other accounts get no Stop button.

**Contract:** emit `agent.started { runId, conversationId }` to the owner when a run starts. Polling
can then be removed.

### 3. Push notifications

No route, token storage or delivery exists anywhere in the core.

**Today:** the app obtains permission and shows system notifications from realtime frames while the
socket lives, which on iOS means seconds after backgrounding. Settings says so explicitly.

**Contract** (the app already calls these and treats 404 as "not supported"):

```
POST   /api/v1/devices/:deviceId/push-token   requireUser, owner only
       body { token: string, provider: "expo" }        -> 200 { data: { registered: true } }
DELETE /api/v1/devices/:deviceId/push-token   requireUser, owner only
       -> 200 { data: { registered: false } }
```

Delivery: on `confirmation.required`, `task.completed`, `task.failed` and `notification.created`,
send to the owner's devices through `https://exp.host/--/api/v2/push/send`, with
`data: { route: "/" | "/missions" | "/notifications" }`, which the app opens on tap. A token must be
deleted on `DeviceNotRegistered`, device revocation and logout. The body must carry no secret:
a lock screen shows it.

The build also needs an EAS `projectId` in `app.json`; without one the app reports "not configured".

### 4. Satellite commands are not scoped to an owner (security)

`POST /satellites/:deviceId/commands` and `GET /satellites` use `requireUser` with no ownership
check, and `SatelliteService` holds no owner: **any account of the core can list every satellite and
send it `infrared.transmit` or `audio.privacy`.**

**Today:** the app exposes only the three parameterless diagnostics commands, for the signed-in
user, and does not add a client-side restriction it could not enforce.

**Contract:** bind a satellite to a user at provisioning, and answer 404 for anyone else.

## Priority 2: limits a feature

### 5. Reading a satellite command's result

Results are stored by `SatelliteService`, but no route lets a client read them.

**Today:** the app says "queued", the only thing it knows.

**Contract:** `GET /api/v1/satellites/:deviceId/commands/:correlationId`
→ `{ data: { state: "queued" | "delivered" | "completed", result: { ok, status, message, data } | null } }`.
Also document the `params` of `led.set`, `audio.privacy` and `infrared.transmit`; the app does not
offer them until then.

### 6. Model selection per conversation

`POST /agent-core/runs` and `message.send` take no model. The only real choice is server-wide:
`PUT /dashboard/llm/engines`.

**Today:** routing is edited under Models & providers (administrator). The chat offers no model
picker, since it would change nothing.

**Contract:** optional `model?: string` on `POST /agent-core/runs`, validated against enabled
engines, 400 otherwise. The catalogue must be limited to usable models; `/providers/models` lists
known ones, configured or not.

### 7. Listing pending confirmations

The channel carries `confirmation.required` once. Only `GET /confirmations/:id` exists, so a client
that was offline at that moment cannot discover the request: the attach backlog helps only if it is
retained until reconnection.

**Today:** runs in `waiting_for_confirmation` can be answered from Agents. Task confirmations missed
while offline are invisible until the backlog replays them.

**Contract:** `GET /api/v1/confirmations?status=pending`
→ `{ data: [{ id, taskId, capability, action, description, riskLevel, expiresAt }] }`.

### 8. Most recent messages first

`GET /conversations/:id/messages` pages forward from the oldest (`createdAt asc`).

**Today:** the app walks at most 5 pages (500 messages) and says when a conversation is cut short,
so the end of a very long conversation is not shown.

**Contract:** `?order=desc` with the same cursor semantics.

### 9. Listing tasks and runs without administrator rights

`GET /dashboard/tasks`, `/dashboard/runs` and `/dashboard/mission-control` use `requireAdmin`, and
there is no user-scoped equivalent, while `POST /tasks` and `POST /agent-core/runs` are open to any
user. A non-administrator can start work they cannot list afterwards.

**Today:** those screens show "Administrator access required". Live tasks still appear in-app.

**Contract:** `GET /api/v1/tasks` and `GET /api/v1/agent-core/runs`, scoped to the caller.

### 10. Server speech

`@nexus/voice` implements Whisper and Piper, but no HTTP route exposes them, so a phone cannot reach
them.

**Today:** dictation and speech use the phone's own engines, driven by the shared `VoicePipeline`.
Nothing is simulated, but this is not the NEXUS speech stack.

**Contract, if wanted:** `POST /api/v1/voice/transcribe` (audio body) → `{ data: { text } }`;
`POST /api/v1/voice/synthesize` `{ text }` → `audio/wav`. Both must be rate limited and not persist audio.

### 11. Provider-reported quota and billed cost

`/usage` reports `billedCostUsd: null` and `providerQuota: null`; `/usage/quotas` answers 503. On
`master`, `/usage` is 503 too; `feat/full-product-integration` makes it answer from run records.

**Today:** the app handles both: 503 shows "Service not available", 200 shows recorded tokens. A
cost appears only as an estimate from prices declared on engines, labelled as such.

## Priority 3: packaging

### 12. `@nexus/client-core` does not bundle for React Native

`src/index.ts` re-exports `offline/peer-sync.ts`, which imports `node:crypto`, which Metro cannot resolve. `expo export` failed on this import during this
work, and `client-core` is unchanged from `master`, so **the app cannot be bundled from `master`**.

**Today:** `metro.config.js` maps `node:crypto` to a shim that throws if called. Peer sync is not used
on mobile.

**Contract:** expose peer sync from a separate entry point (`@nexus/client-core/peer-sync`), or take a
crypto port like the other platform dependencies. The shim can then be removed.

### 14. The realtime handshake reports every failure as a missing session

`RealtimeClient.#connect` catches anything thrown while sending the handshake, assumes the token is
missing, stops retrying and goes offline without dispatching an error. On Hermes this hid a missing
`globalThis.crypto` behind a permanent "Connecting" state. The comment in
`packages/shared/src/ids.ts` also says Hermes provides that API; it does not in this app.

**Today:** `lib/web-crypto.ts` installs the source, so the path is no longer reached this way.

**Contract:** catch only `NotAuthenticatedError` there. Let any other error reach `#scheduleReconnect`
or dispatch `CLIENT_HANDSHAKE_FAILED`, and correct the comment.
