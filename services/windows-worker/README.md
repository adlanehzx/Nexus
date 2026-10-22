# @nexus/windows-worker

Windows worker: controlled local capabilities with an **outbound** connection to the
NEXUS Core.

**Status: Implemented and tested.** 190 tests, running without launching arbitrary
host processes or writing temporary files on the developer's workstation.

The same binary runs on laptops and desktop workstations alike. Nothing in this
package assumes or knows which specific hardware it runs on.

---

## Principle

```
Windows Worker ──(Outbound WebSocket)──▶ NEXUS Core
                                            │
                                      WorkerGateway  (implements WorkerTransport)
                                            │
                                TaskCoordinator ◀── DeviceSelector
                                            │
                                         Agent
```

The arrow direction is the central architectural decision. **The worker calls the
Core; the Core cannot initiate connections to the Windows machine.** It communicates
back across the pre-established, authenticated outbound connection.

Direct benefits:

- Zero port forwarding, no inbound open ports, no exposed attack surface;
- Functions seamlessly behind residential NAT, corporate VPNs, or mobile hotspots
  without custom network configuration;
- Clients never talk directly to workers: everything routes through the Core.

---

## There Is No `execute(command: string)`

This is the primary security invariant enforced by this package; automated tests
fail if it is violated. The execution interface is strictly structured:

```jsonc
// terminal.execute
{
  "executable": "git",
  "args": ["status", "--porcelain"],
  "workingDirectory": "C:\\Projects\\nexus",
}
```

Three compounding security guarantees:

1. An executable chosen from an allowlist cannot be substituted or injected via `;` or `&&`;
2. Arguments passed as an array are never re-evaluated by a shell — `; rm -rf .` passed
   to `git` is an invalid git argument, not an executed shell command;
3. `spawn` is invoked with `shell: false`, completely preventing variable expansion,
   command substitution, and glob matching.

**Security derives from API structure, not string sanitization filters.** String filters
can be bypassed; an API that fundamentally rejects arbitrary command strings cannot.

---

## Installation

### Published Installer (Recommended)

1. Run `nexus-worker-<version>-setup.exe` from the official NEXUS release assets.
2. In the dashboard, navigate to **Devices**, enter a device name, and click **Create Pairing Code**.
3. Copy the provided PowerShell pairing command and run it in an elevated Administrator prompt.
4. Return to **Devices** in the dashboard and click **Approve**.

The command generates an Ed25519 keypair locally on the PC, consumes the one-time pairing ticket,
writes `worker.env`, locks down Windows filesystem ACLs, and registers the Windows service.
Pairing tokens and private keys are never stored together.

### From Source

```powershell
pnpm install
pnpm --filter @nexus/windows-worker build
pnpm --filter @nexus/windows-worker pair -- `
  --api-url https://your-nexus-host `
  --token DASHBOARD_PAIRING_CODE `
  --key-path C:\ProgramData\NEXUS\nexus-device.key `
  --env-path .env `
  --allowed-paths C:\Projects
pnpm --filter @nexus/windows-worker start
```

`.env.example` contains only placeholder values — verified by test. The private key is
referenced strictly via a filesystem **path**, never an inline variable value: keys stored
in environment variables easily leak into shell history, scheduler logs, or crash dumps.

---

## Configuration

| Variable                       | Purpose                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `NEXUS_BACKEND_URL`            | NEXUS Core URL. Remote addresses **must** use `wss://` — worker refuses to boot over insecure links |
| `DEVICE_ID`                    | Assigned during pairing. Public identifier: never used for authentication                           |
| `DEVICE_CREDENTIAL_PATH`       | Filesystem path to the local Ed25519 private key                                                    |
| `WORKER_ALLOWED_PATHS`         | Allowed root paths for read and write operations. All other paths are rejected                      |
| `WORKER_CAPABILITIES`          | Exposed capabilities list. Empty = all locally verified capabilities                                |
| `WORKER_ALLOWED_EXECUTABLES`   | Allowlisted executables. Empty = default safe binary list                                           |
| `WORKER_ALLOWED_ENV`           | Whitelist of environment variables propagated to child processes                                    |
| `WORKER_HEARTBEAT_INTERVAL_MS` | Default: 20000 (20s)                                                                                |
| `WORKER_TASK_TIMEOUT_MS`       | Default: 300000 (5 min)                                                                             |
| `WORKER_MAX_CONCURRENT_TASKS`  | Concurrency ceiling. When reached, worker rejects additional tasks — Core routes elsewhere          |
| `WORKER_DOCKER_ALLOWED`        | Allowed Docker subcommands. Default: inspection only                                                |
| `WORKER_GIT_ALLOW_WRITE`       | Allows mutating git commands (`pull`, `checkout`, `commit`, `clone`). Default: false                |

The device **role** (`CLIENT`, `WORKER`, `BOTH`) is deliberately omitted from configuration:
it is maintained in the Core registry. A worker must never self-assign or escalate its role.

---

## Capabilities

| Capability                           | Risk   | Notes                                                                           |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------- |
| `terminal.execute`                   | HIGH   | Structured executable + args. Never arbitrary command lines                     |
| `filesystem.read`                    | SAFE   | Bounded read length, output redacted                                            |
| `filesystem.write`                   | MEDIUM | Rejects file overwrites without explicit overwrite flag                         |
| `process.list`                       | SAFE   | Process table inspection                                                        |
| `process.start`                      | HIGH   | Detached execution: survives worker restart                                     |
| `process.stop`                       | HIGH   | **Strictly limited** to processes spawned by NEXUS                              |
| `docker.execute`                     | HIGH   | Read-only by default; `--privileged` and socket mounting are always forbidden   |
| `git.status` `git.diff` `git.branch` | SAFE   | Read-only Git operations                                                        |
| `git.pull` `git.clone` `git.commit`  | MEDIUM | Mutating Git operations, disabled by default                                    |
| `git.checkout`                       | HIGH   | Only operation capable of discarding uncommitted workspace changes              |
| `browser.open`                       | LOW    | Displays URL on the **user's active display**. Performs no automation or clicks |

Seven discrete Git capabilities rather than a generic `git.execute`: this enables granting
`git.status` without granting `git.checkout`, allowing the Core to require confirmation for the
latter but not the former.

`browser.open` **is not a duplicate of Browser Use**. Browser Use automates a headless or managed
browser (reads, clicks, inputs). `browser.open` presents a URL in the user's default browser window
on their screen. Conflating them would create an unconstrained automation vector without safeguards.

### Dynamic Capability Advertisement

A capability is only advertised if it is **actually available** on the host (Docker only if the
daemon responds, Git only if the executable is detected in PATH) **and** explicitly permitted by
configuration. Advertising unfulfillable capabilities degrades routing: the selector would choose
the host only for the execution to fail, bypassing other capable nodes.

---

## Security

- **Device IDs never authenticate.** They are public identifiers. Every connection signs an
  Ed25519 challenge; the private key never leaves the host.
- **Anti-replay protection** on authentication challenges and heartbeats (`requestId` + bounded timestamp).
- **Session reconnection without token reuse**: reconnection always completes a fresh cryptographic handshake.
- **Path sandboxing**: Declared directory roots, symlink resolution **before** path boundary comparison,
  rejection of directory traversal (`..`), UNC paths, `\\?\` prefixes, NTFS alternate data streams (ADS),
  reserved DOS device names, and paths containing credential files — even when located inside allowed roots.
- **Process containment**: `process.stop` only controls processes spawned by NEXUS. Without this rule,
  terminating a dev server and stopping system security software would share the same permission.
- **Environment filtering**: Child process environments are never inherited en bloc; whitelists apply in both directions.
- **Git safeguards**: `GIT_TERMINAL_PROMPT=0` and empty `GIT_ASKPASS` — unauthenticated private repos fail immediately
  instead of hanging indefinitely on interactive prompts. The `ext::` transport protocol is unconditionally blocked,
  preventing arbitrary command execution during clone.
- **Redaction**: Process stdout/stderr, read file contents, and logged arguments pass through `redact` / `redactText`
  from `@nexus/shared`. The worker executes real values; logs and event streams record `[REDACTED]`.
- **Never logged**: Passwords, API keys, access and refresh tokens, cookies, cryptographic signatures, private keys,
  and sensitive secrets returned by child processes.

---

## Lifecycle

```
start → connect → hello → challenge → authenticate → session
      → register → heartbeat ⇄ receive/execute → shutdown
```

A network drop at any point resets state to `connect`, with exponential backoff **and jitter**.
Jitter is essential: without it, multiple fleet workers reconnect in lockstep, overwhelming the Core upon restart.

On graceful shutdown, active tasks are cancelled and reported as failed **before** closing the transport channel —
preventing the task coordinator from hanging until task timeout expiration.

---

## Step Execution Pipeline

```
Known capability → Available capability → Arguments schema validation → Capability concurrency slot
  → Local host policy → Timeout-bounded execution → Progress reporting → Final result
```

Validation halts at the first rejection. Any instruction that fails the initial four validation stages
never reaches the operating system.

While the Core validates user permissions and human confirmations, the worker independently re-verifies
its own constraints: it remains the final authority on what is physically permitted on the host, ensuring
that a compromised Core cannot issue arbitrary system calls.

---

## Tests

```bash
pnpm --filter @nexus/windows-worker test
```

`ProcessRunner` and `FileSystemPort` are ports, mocked with in-memory test doubles during automated runs.
The entire execution pipeline — policies, timeouts, cancellation, redaction — is verified without spawning
live processes. All other components run real code: Ed25519 keys, cryptographic signatures, genuine
`DeviceSessionService`, `WorkerGateway`, and `TaskCoordinator`.

---

## WebSocket Link Architecture

The worker does not depend directly on WebSockets: it depends on the `WorkerLink` port abstraction:

```ts
export interface WorkerLink {
  readonly state: LinkState;
  connect(): Promise<void>;
  send(envelope: Envelope): Promise<void>;
  close(reason: string): Promise<void>;
  onMessage(handler: (envelope: unknown) => void): void;
  onClose(handler: (reason: string) => void): void;
}
```

The interface exposes `connect()`, not `listen()`: the worker is architecturally unable to accept inbound connections.

On the Core side, `WorkerGateway` expects a `WorkerConnection` (`send`, `close`) and handles messages through
a single entry point: `WorkerGateway.handleMessage(connection, frame)`.

The real network adapter is `WebSocketLink` (`src/connection/websocket-link.ts`): opening the socket to
`NEXUS_BACKEND_URL`, routing JSON envelopes bidirectionally, and signaling disconnection. Core logic resides in
`WorkerRuntime` and was verified using `LoopbackLink`.

Two strict rules enforced:

- **Cleartext remote connections are rejected.** Signed challenges authenticate the machine but do not encrypt
  subsequent traffic; over unencrypted connections, execution commands would be readable and modifiable in transit.
- **Maximum frame size capped at 256 KB.** Data exceeding 256 KB represents bulk transfer rather than task instructions,
  and client-side limits protect against memory exhaustion from malicious or rogue servers.

---

## Local State Card

On boot, the daemon writes its **public** state to `WORKER_STATE_PATH` (`%ProgramData%\\NEXUS\\worker\\device.json` by default):

```json
{
  "deviceId": "…",
  "platform": "WINDOWS",
  "workerVersion": "0.1.0",
  "startedAt": "…"
}
```

The sole reader is the local NEXUS desktop UI, which reads this identifier to correlate itself in the device list
returned by the Core, avoiding duplicate device entries.

This file **grants no permissions**. It contains no private keys, no allowed paths, and no Core credentials, and
no IPC control channel exists between the desktop UI and daemon. It serves purely as a read-only local identifier.

---

## Diagnostics

| Symptom                          | Likely Cause                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Worker stuck in `authenticating` | Public key missing on Core, or device still in `PENDING` status                                             |
| Worker stuck in `reconnecting`   | `NEXUS_BACKEND_URL` unreachable; inspect `attempt` count in logs                                            |
| `CAPABILITY_UNAVAILABLE`         | Three distinct causes distinguishable via error context: unimplemented, locally disabled, or missing binary |
| `PATH_NOT_ALLOWED`               | Specific rejection reason detailed in `context.reason`                                                      |
| `WORKER_SATURATED`               | `WORKER_MAX_CONCURRENT_TASKS` reached; retryable on alternative worker                                      |
| Docker capability absent         | Docker daemon is not running: health probe failed, capability withheld                                      |
