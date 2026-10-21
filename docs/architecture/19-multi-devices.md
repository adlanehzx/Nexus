# 19 — Multi-Device Architecture (Implemented Architecture)

Describes the multi-device subsystem **as built in the codebase**. Document [06 — Devices & Device Agent](06-devices.md)
establishes the conceptual design; this document reflects the implemented code.
Package: [`@nexus/devices`](../../packages/devices).

## 1. The Core Architecture Problem

NEXUS is not an assistant that executes on a single isolated workstation. It is an assistant that operates
**across a fleet of heterogeneous machines**: a user talks to it from mobile, execution runs on a primary
workstation, notifications deliver to a secondary device, and the desktop dashboard observes progress
in real time. The core question is not "how to execute a command", but **"who executes, and who receives
the results?"**

Two architectural invariants govern the design:

1. **The Core Never Identifies Devices by Name.** It manages roles, types, and capability flags. A user's
   personal device name is a database record, never a hardcoded conditional in code. Enrolling additional
   computers is purely a database insertion.
2. **All Communication Flows Through the Center.** Client devices never communicate directly peer-to-peer.
   Zero distributed peer state outside PostgreSQL and Redis. This guarantees that a mobile phone reconnecting
   after hours of sleep observes the identical state as an active desktop session.

## 2. Processing Pipeline

```
                        ┌──────────────── DeviceRegistry ──────────────┐
                        │ Who exists · What can it do · Is it healthy  │
                        └───────────────────┬──────────────────────────┘
                                            │
   TaskPlan ──▶ TaskCoordinator ──▶ DeviceSelector ──▶ WorkerTransport ──▶ Worker
                       │                 (Which?)
                       ├──▶ ConfirmationGate      (Risk ≥ Threshold)
                       └──▶ EventRouter ──▶ All Connected User Clients
                                              (Originating device first)
```

In parallel, the bridge exposing device capabilities as agent tools:

```
Capability ──▶ createDeviceTools ──▶ ToolDefinition ──▶ ToolRegistry ──▶ Agent Core
```

## 3. Role, Type, and Capability: Three Distinct Axes

Conflating these three dimensions prevents fleets from scaling cleanly:

| Axis           | Semantic Question                       | Concrete Example           |
| -------------- | --------------------------------------- | -------------------------- |
| **Role**       | Is the device authorized to execute?   | `CLIENT`, `WORKER`, `BOTH` |
| **Type**       | What hardware/OS platform is it?        | `IPHONE`, `WINDOWS_PC`     |
| **Capability** | What actions can the machine perform?   | `terminal.execute`         |

A primary laptop configured with role `BOTH` acts as an interactive client chat interface _and_
executes background worker tasks. A device configured strictly as `CLIENT` is never selected as an
executor even if it advertises capabilities — the device role takes precedence.

**Capabilities share the permission namespace** (`domain.action`). This is deliberate: a capability
asserts what a device _can_ perform; a permission grant defines what the user _authorizes_. Both must
be satisfied. Shared naming makes audit trails and UI permission editors clear and unambiguous.

## 4. Selection Algorithm: Ten Criteria, Zero Hardcoded Names

`DeviceSelector` applies strict **hard filters** ordered for rapid diagnostic evaluation — exclusion lists,
role check, revocation status, trust status, health, required capabilities, permission grants, device
saturation limits, and environmental constraints. Every rejection is accompanied by an explicit reason,
answering why a device was not selected without custom log instrumentation.

Eligible candidate devices are **scored** according to:
Explicit User Preference (1000) ≫ Availability (300) > Health (200) > Latency (150) > AC Power (100) > Specialization (50).
User preferences prioritize devices among eligible candidates, but never bypass security filters.

## 5. `TaskPlan` vs. `AgentRun`

This boundary is strictly maintained. An `AgentRun` (see [16](16-agent-core.md)) describes an **autonomous
reasoning loop** — observe, reason, call tool. A `TaskPlan` describes **distributed execution** across
machines — workstation clones a repository, laptop runs test suites, mobile phone chimes a notification.
An agent run may generate a task plan; a task plan can execute independently without an LLM.

Task step DAGs are validated upon construction: duplicate IDs, dangling dependencies, and **dependency
cycles** are rejected immediately at initialization.

## 6. `originClientDeviceId`: The Routing Thread

This identifier traverses the entire subsystem. A request originating from mobile executes on a
workstation, and its streaming events return **to the mobile device first** — because that is where the
user is watching. Secondary connected clients receive events in the same broadcast fanout.

Disconnected clients do not lose events: missed frames queue in a **bounded buffer** (200 events per device).
Devices offline for days do not leak server memory: exceeding the buffer triggers a complete state
resynchronization upon reconnection rather than replaying large historical streams.

## 7. Security Architecture

- **Device IDs Never Authenticate Inbound Traffic.** Device IDs are public strings visible in UI dashboards.
  Authentication requires a **signed Ed25519 challenge**, yielding a short-lived bearer token whose hash
  is checked. Nonces are consumed even on failed handshakes to prevent replay attacks.
- **Trust and Online Status are Decoupled.** A newly enrolled machine enters `PENDING` status: online,
  yet assigned zero tasks until approved by an administrator. `revokeTrust` is reversible; `revokeDevice`
  is permanent.
- **Pre-Dispatch Capability Re-verification.** Capabilities are re-validated immediately before task
  dispatch: a device might have lost a capability between initial selection and execution.
- **Zero Generic Command Endpoints.** Workers do not expose arbitrary `execute(string)` interfaces;
  they expose discrete typed capabilities.
- **Data Redaction**: Task execution logs pass arguments through `@nexus/shared` `redact`. Passwords
  passed to `terminal.execute` reach the worker process and are redacted before reaching database logs.
  Broadcast event envelopes never carry raw arguments — metadata only.

## 7 bis. Device Credentials: Storage and Revocation

### Addressing Silent Key Drift

The `device_credentials` table existed in early schemas while production code mounted `InMemoryCredentialProvider`.
The consequence was silent failure: restarting the API wiped all enrolled public keys from memory.
Workers attempting to reconnect signed challenges successfully, only to be rejected because the server
had lost the keys required to verify them.

Test suites now verify persistence against real database layers by creating a **second** store instance
to reload keys from disk — accurately validating restart recovery.

### Algorithm Derived Directly from Key Material

The signing algorithm is inferred from the cryptographic key itself, not client-supplied strings:
`createPublicKey(pem).asymmetricKeyType` determines the verifier, preventing algorithmic confusion attacks.

### Key Rotation and Revocation

| Action                                     | Database State                                                                 | Effect on Verification                  |
| ------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------- |
| `set` on a device with an existing key     | Prior key receives `rotatedAt` and `revokedAt`; new row is created             | New key verifies; old key rejected      |
| `revoke`                                   | `revokedAt` applied across all active key rows                                 | All inbound handshakes rejected         |

**Single Active Key**: Devices maintain exactly one active key to avoid ambiguous verification states.
**Revocation Preserves Audit Trails**: Public keys are historical records; revoked keys are marked
rather than deleted, allowing post-incident forensic audits.

### Device Revocation Cleans Keys

Revoking a device closes active sessions, detaches it from the gateway, and revokes its public key.
Even if future code paths were to overlook trust verification, an un-verifiable handshake prevents access.

## 7 ter. Pairing via QR Code

### Eliminating Manual Key Transport

Private keys originate inside client hardware keystores and never leave the device. Transporting public
keys to the central server previously required manual copying into the dashboard.

The pairing ticket automates this physical transport securely:

```
  Dashboard (Authenticated)                     Mobile Device
  POST /devices/pairing-tickets  ──▶  QR: nexus://pair?api=…&token=…
                                              │
                                              ▼  (Zero identity yet)
                                        POST /devices/pair
                                              │
  Device marked PENDING under ticket owner ◀──┘
                                              │
  Explicit Admin Approval ────────────────────┘  Followed by first session
```

Asymmetric route design: issuing tickets requires an authenticated session; consuming a ticket requires
only the ticket itself — because the scanning device does not yet possess an identity.

### Tight Security Window

| Property                             | Threat Mitigated                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Single-Use** (`consumedAt`)        | A QR photographed over a shoulder cannot be reused once paired                                       |
| **5-Minute TTL**                     | Exceeds pairing workflow time while minimizing exposure windows                                      |
| **Hashed at Rest**                   | Only SHA-256 hashes are stored; lookups evaluate via hashes, preventing timing side-channel attacks   |
| **Ownership Embedded in Ticket**     | Presenters cannot select which user account the device binds to                                      |

Tickets verify physical presence and key delivery; they do not grant automatic trust. Enrolled devices
arrive in `PENDING` status awaiting explicit user approval.

### Explicit `PUBLIC_API_URL`

QR payloads embed the configured public API URL. It is never inferred from inbound `Host` headers,
preventing attackers from poisoning QR pairing destinations. The custom `nexus://` scheme prevents
standard web browsers from opening pairing tokens into external browser history or proxies.

## 7 quater. Extended Outage Resilience

Extended network interruptions — laptops closed overnight, Wi-Fi toggled off during commutes, or
backend migrations — represent critical edge cases tested in `services/windows-worker/test/long-outage.test.ts`:

- Reconnection performs a **complete fresh handshake**;
- Reconnected devices return to **online and trusted** status without requiring re-pairing;
- Task plans execute successfully post-reconnect;
- Backoff delays grow with upper-half jitter and enforce a reasonable ceiling;
- Pre-outage nonces cannot be replayed post-reconnect;
- Tasks assigned during outages fail cleanly rather than remaining perpetually queued.

## 7 quinquies. Worker Version Governance

The central server **observes** worker versions; it never pushes executable binary updates directly.
A push-based remote update mechanism would represent remote code execution. Local host security
policies exist to ensure that even if the central server is compromised, worker machines remain protected.

The server reports version status against `EXPECTED_WORKER_VERSION`:

| Status          | Meaning                                        | Operator Action                                              |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `up-to-date`    | Version matches expected release               | None                                                         |
| `outdated`      | Newer release is available                     | Local package update, installer run, or git pull and restart |
| `ahead`         | Local development or canary build              | None                                                         |
| `unknown`       | Missing or unparseable version string          | Verify worker service status                                 |

Semver comparisons evaluate numerically segment-by-segment (`1.2.0-rc.1` properly precedes `1.2.0`),
preventing lexical string comparison errors.

## 8. Seamless Agent Integration

Device capabilities map directly into standard `ToolDefinition` instances inside the central `ToolRegistry`,
namespaced as `device.<capability>` — mirroring the MCP pattern. They inherit permissions, confirmation
gates, argument validation, timeouts, retries, and audit logs automatically.

The agent core sees tools like `device.terminal.execute` without coupling to specific hardware hostnames,
preventing model hardware biases and keeping machines interchangeable.
