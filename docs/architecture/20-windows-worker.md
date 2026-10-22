# 20 — Windows Worker (Implemented Architecture)

Describes the Windows Worker subsystem **as built in the codebase**. Document [19 — Multi-Device Architecture](19-multi-devices.md)
establishes the overarching framework; this document reflects the implemented code.
Package: [`@nexus/windows-worker`](../../services/windows-worker).

## 1. What Was Delivered

The multi-device core declared a transport port, `WorkerTransport`, without coupling to concrete worker
implementations. This milestone provided both ends of the bridge:

- **`WorkerGateway`** (`@nexus/devices`) implementing `WorkerTransport`;
- **`@nexus/windows-worker`** as the first physical worker node.

`TaskCoordinator`, `DeviceSelector`, `TaskPlan`, `PermissionService`, `ConfirmationService`, and
`createDeviceTools` remain **completely unchanged**. The worker interfaces with them as a standard
worker node, exactly as designed.

## 2. Inverted Connection Direction

```
Windows Worker ──(Outbound WebSocket, wss://)──▶ NEXUS Core
                                                     │
                                               WorkerGateway
                                                     │
                                     TaskCoordinator ◀── DeviceSelector
                                                     │
                                                   Agent
```

**The worker initiates connections to the central core.** The core does not initiate inbound connections
to Windows workstations; it dispatches tasks over the pre-established outbound channel. This is an
invariant property enforced by the interface contract: `WorkerLink` exposes `connect()`, never `listen()`.

Zero firewall port forwarding, zero exposed host endpoints, and zero client devices communicating directly with workers.

## 3. Identical Code Across Workstations and Laptops

| Configuration   | Laptop Node  | Workstation Node |
| --------------- | ------------ | ---------------- |
| Role            | `BOTH`       | `WORKER`         |
| Device Type     | `WINDOWS_PC` | `WINDOWS_PC`     |
| Executable Code | Identical    | Identical        |

Nothing inside the worker inspects its configured device role or friendly name: those attributes derive
from the central database registry. Tests verify this by connecting the identical worker class under two
different machine identities and verifying matching advertised capabilities and execution behavior.

Enrolling a new machine is purely a **database record addition**.

## 4. Elimination of Arbitrary Shell Execution

This is the primary security constraint. No capability accepts raw command strings; `terminal.execute`
requires an executable binary selected from an allowlist alongside an explicit array of arguments,
spawning processes with `shell: false`.

Security derives from **API design**, not fragile string regexes. Automated tests verify this across
three vectors: zero advertised capabilities expose a `command` string property, zero source files import
`exec` or `execSync`, and every `spawn` invocation specifies `shell: false`.

Design consequence: adversarial injections fail harmlessly. Passing `git log "&& del /S /Q C:\Projects"`
invokes `git` with an unusual argument string. A single command runs, and that command is `git`. There
is no shell to interpret chained commands.

`.bat` and `.cmd` scripts are explicitly rejected: Node invokes batch files through `cmd.exe`, which
would reintroduce shell interpretation.

## 5. Seven Distinct Git Capabilities, Not a Generic `git.execute`

Granular capabilities allow granting `git.status` while denying `git.checkout`, and allow the central
core to require human confirmation for destructive mutations while treating read commands as safe.
A generic `git.execute` would require string scraping to infer intent.

`git.checkout` is classified as `HIGH` risk, above `commit` and `pull`: it is capable of discarding
uncommitted local changes without automated recovery.

## 6. Dynamic Capability Advertising

Two conditions must be met for a capability to be advertised: it must be **verified present** (probed
at runtime — e.g. Docker daemon answers, Git binary exists) and **explicitly permitted** in local configuration.

Advertising capabilities that cannot be fulfilled is worse than remaining silent: the selector would
assign the task to that machine, causing execution failure while bypassing other available workers.

The central server maintains authority: `worker.registered` returns the **accepted** capability set,
which the worker adopts.

## 7. Cryptographic Authentication

Integrates with `DeviceSessionService` without modification:

```
hello ─▶ (Cryptographic Challenge) ─▶ authenticate (Nonce signed via Ed25519) ─▶ session
```

`hello` grants zero privileges: device IDs are public identifiers. Private keys never leave the host
workstation; local configuration points to key files via **filesystem path**, never raw key bytes.

Replay protection (`requestId` + bounded timestamp) covers authentication and heartbeat frames.
Reconnecting requires a fresh handshake: stale sessions are discarded.

## 8. Multi-Layered Data Redaction

Three points of interception:

1. **Process Output Streams** — Program outputs cannot be predicted. A build script emitting an API
   token must not leak into central server logs.
2. **Read File Payloads** — Reading `.env` files via `filesystem.read` is a standard developer action.
3. **Logged Arguments** — The worker receives raw arguments for execution, while central audit logs
   record `[REDACTED]`.

`@nexus/shared` provides `redactText`, which sanitizes credentials **inside unstructured text blocks**,
complementing structural key-based redaction.

## 9. Lifecycle Events

Four events extend the protocol union: `worker.connected`, `worker.ready`, `worker.disconnected`, and
`worker.task_cancelled`.

`device.connected` indicates "the central registry recognizes this machine"; `worker.connected`
indicates "the execution channel is open and ready". A device can be enrolled without being ready for
task execution — distinguishing these states aids system diagnostics.

## 10. Decoupled Transport Layer

The worker depends on the `WorkerLink` port interface rather than hardcoded WebSockets; real network
transports attach clean JSON framing and disconnect handlers. Unit tests validate end-to-end execution
against `LoopbackLink`, verifying protocol mechanics independently of network sockets.
