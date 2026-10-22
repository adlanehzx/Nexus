# 22 — API and Real-Time Gateway (Implemented Architecture)

Describes the network boundary **as built in the codebase**. Documents [02 — Backend](02-backend.md)
and [08 — WebSocket Protocol](08-websocket-protocol.md) establish the initial architecture; this
document reflects the implemented code.

## 1. What Was Delivered

Existing core business logic remains untouched. `TaskCoordinator`, `DeviceSelector`, `WorkerGateway`,
`DeviceSessionService`, `PermissionService`, `ConfirmationService`, `EventRouter`, and both workers
remain **identical** — their 425 unit tests pass as-is.

The API layer wires these components together:

1. **`@nexus/auth` was implemented** — providing EdDSA keypair token signing, scrypt password hashing,
   and session rotation logic.
2. **Client Gateway Channel** (`@nexus/protocol/client.ts`), mirroring the worker channel with disjoint
   message types inside a shared `envelopeSchema`.
3. **REST Route Controllers and Dual WebSocket Channels**, alongside four core services: conversations,
   notifications, confirmation broker, and task supervisor.

## 2. Centralized Authorization Authority

```
Client ─▶ Route or WebSocket Channel
       ─▶ Verified JWT + Active Session Check
       ─▶ Resource Ownership Check
       ─▶ PermissionService Authorization Check
       ─▶ TaskCoordinator ─▶ DeviceSelector ─▶ WorkerGateway ─▶ Worker Node
```

A client device never assigns tasks directly to an executor. It declares **required capabilities**;
the server's `DeviceSelector` determines the target machine. This prevents compromised mobile devices
from executing arbitrary directed commands on specific workstations.

The two WebSocket channels feature **disjoint types**, disjoint schemas, and separate endpoints.
A forged `worker.task_result` frame sent across a client WebSocket fails schema validation immediately.

## 3. Two Distinct Authentication Boundaries

| Feature                 | User Sessions              | Device Worker Sessions         |
| ----------------------- | -------------------------- | ------------------------------ |
| Credential Proof        | Password → EdDSA JWT token | Signed Ed25519/P-256 challenge |
| Validity Lifespan       | 15 minutes, rotating       | 30 minutes, rotating           |
| Route Guard             | `requireUser`              | `requireDevice`                |
| Act on Behalf of Other? | Prohibited                 | Prohibited                     |

`verifyAccessToken` rejects device tokens, and device validators reject user tokens. Generic guards
that conflate the two identities do not exist.

**Two-Phase Verification**: Cryptographic signatures verify token authenticity; active session lookups
verify non-revocation. Without the second check, logging out would fail to revoke access until the
15-minute token TTL elapsed.

## 4. EdDSA Asymmetric Tokens vs. Shared Secrets

Multiple backend components need to **verify** tokens — API routes, WebSocket gateways, and background
workers — while only the authentication service needs to **issue** tokens. With symmetric HMAC secrets,
every verifying service can forge tokens.

`TokenService.publicKeyPem` distributes public verification keys to services without sharing private
signing credentials.

## 5. Refresh Token Rotation and Anti-Theft Revocation

Refresh tokens rotate on every invocation, immediately invalidating the prior token. If a previously
consumed token is presented again, theft is assumed: **all active sessions for that user account are
instantly terminated**. Both attacker and victim possess a token copy, and the backend treats the
account as compromised.

## 6. Multi-Device Real-Time Synchronization

Synchronizing actions across mobile phones and workstations required **zero specialized sync code**.
`EventRouter` already broadcasts events to all active sessions owned by a user, prioritizing the
originating device and buffering events for disconnected sessions. The client channel simply attaches
to this pipeline.

Three verified properties:

- A task initiated from mobile renders immediately on the desktop dashboard;
- `originClientDeviceId` is preserved across **all** task events — allowing the desktop client to know
  an action was triggered from mobile and silence duplicate audio chimes;
- A disconnected client receives missed events upon reconnection.

**Notifications originate from the central server**, never client devices. If clients generated local
notifications independently, mobile and desktop would display conflicting states for the same event,
and tasks finishing while a mobile device was powered down would generate no notification history.

## 7. Confirmation Broker: Decoupled Human Approval

`ConfirmationBroker` reconciles two seemingly incompatible contracts: `TaskCoordinator` expects a
synchronous resolution promise, while `ConfirmationService` operates non-blockingly.

Key benefit: a confirmation prompt triggered while using mobile can be approved **from the desktop**.
Duplicate approvals (e.g. approving on two screens near-simultaneously) resolve gracefully without
spurious error messages.

Confirmation timeouts evaluate strictly to **rejection**. Silence is never interpreted as consent for
actions that mutate user systems or files.

## 8. Worker Channel Protocol Naming

The task specification requested `worker.task.progress`; the codebase utilizes `worker.task_progress`,
already standardized across both workers and 319 unit tests. The naming was maintained to preserve
contract stability. Client-facing event names adhere strictly to specification standards.

## 9. Next Operational Steps

Prisma schema models exist for users, devices, sessions, conversations, messages, and tasks; database
repositories are ready for persistent PostgreSQL storage behind existing repository interfaces without
changing route controllers.
WebSocket route integration wires `@fastify/websocket` to `ClientChannel` and `WorkerChannel` via
`authenticate`, `attach`, `handle`, and `detach` hooks.
