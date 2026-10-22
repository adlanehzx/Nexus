# @nexus/browser-worker-host

Connects **Browser Use to the NEXUS WorkerGateway**. It serves as the third worker
in the fleet, following the Windows worker (Phase 7) and the Android worker (Phase 8),
utilizing the exact same underlying runtime.

**Status: Implemented and tested.** 55 tests, including 4 end-to-end tests against
the real Python worker.

---

## The Problem Solved by This Package

The Browser Use worker already existed — a full Python service with session management,
intent policies, and 75 tests — but lived **adjacent to** NEXUS rather than within it:

|                       | Before                   | Now                                      |
| --------------------- | ------------------------ | ---------------------------------------- |
| Core authentication   | Static service token     | **Ed25519 challenge signature**          |
| Identity              | None                     | Registered device in registry, revocable |
| Session               | None                     | `DeviceSessionService`, with rotation    |
| Capabilities          | Not advertised           | **Advertised and registered**            |
| Selection             | Never selected by Core   | `DeviceSelector`, capability-matched     |
| Permissions           | Outside permission model | `browser.*`, standard capability names   |
| Human confirmations   | Isolated custom tool     | `ConfirmationBroker`, risk-tiered        |
| Health & availability | Invisible                | Heartbeats and probes                    |

The `BROWSER_WORKER` device type existed in `@nexus/devices` since inception, with the
comment: "Browser Use is a full-fledged worker from the selector's perspective". Nothing
implemented it. That is what this package delivers.

---

## Architecture

```
User → Agent → Plan → Required Capabilities → Authorization
                                                  │
                                          WorkerGateway
                                                  │
                                 Authenticated Session (Ed25519)
                                                  │
                                    @nexus/browser-worker-host
                                                  │  HTTP, versioned contract
                                     services/browser-worker (Python)
                                                  │
                                         browser-use → Chromium
```

**Two processes, two rationales.** A Chromium crash must never terminate the Core session,
and the process browsing untrusted web content must not hold the host device key. The
boundary is an explicit HTTP contract, never an in-process binding (ADR-006).

**This package does not directly control a browser.** It translates NEXUS capabilities into
calls to the Python worker. The entire lifecycle — handshake, registration, heartbeats,
task dispatch, cancellation, resumption — comes from `@nexus/worker-core`, with zero duplicated
code.

---

## Capabilities

One capability **per intent**, never a generic catch-all capability. This allows the rest
of NEXUS to operate without needing browser-specific knowledge: reading a price and paying
for an order are technically identical clicks, but entirely distinct semantic actions.

| Capability         | Intent     | Risk Level   | Confirmation\* | What the Python worker removes        |
| ------------------ | ---------- | ------------ | -------------- | ------------------------------------- |
| `browser.navigate` | `read`     | **LOW**      | No             | click, input, tabs, JS eval, file ops |
| `browser.interact` | `interact` | **MEDIUM**   | Yes            | JS eval, file ops                     |
| `browser.login`    | `login`    | **HIGH**     | Yes            | JS eval, file ops                     |
| `browser.purchase` | `purchase` | **CRITICAL** | Yes            | JS eval, file ops                     |

\* At default threshold (`MEDIUM`).

The capability name **is** the permission name: `permissionForCapability` is identity-based,
and users see exactly what they authorize in their settings.

**Intents are enforced, not merely declarative.** The Python worker actively restricts
available actions (`app/policies.py`): `browser.navigate` cannot execute clicks even if the
LLM requests it, and `evaluate` — arbitrary JavaScript execution — is stripped for **all**
intents.

### Why Policy Enforcement Belongs in the Worker

The Core decides _what is intended_; the worker decides _what is physically permitted_.
A compromised Core must not be able to escalate a read intent into a purchase. Duplicating
the enforcement policy in the host would lead to divergence — and the more permissive policy
always wins. A test asserts that no action restriction rules are reimplemented here.

---

## Browser Sessions

**One session per NEXUS task.**

- **Steps within the same task** reuse the session: "log in, then place an order" would otherwise
  lose authentication between consecutive steps.
- **Two separate tasks never share a session**: a task that logged into banking services must never
  leave its active browser session accessible to a subsequent task that may visit untrusted pages.

User isolation is enforced one layer above: the device registry binds each device to a `userId`
upon pairing, and browser workers adhere strictly to this model.

On shutdown, browsers are cleanly terminated — orphaned Chromium processes do not outlive the host.

---

## Installation

```bash
# 1. The Python worker must be running (see services/browser-worker/README.md).

# 2. Register the worker on the Core: type BROWSER_WORKER, role WORKER.
#    The Core generates DEVICE_ID and grants permissions.

# 3. Generate the device keypair and register the public half in the registry:
openssl genpkey -algorithm ed25519 -out device.pem
openssl pkey -in device.pem -pubout

# 4. Copy .env.example to .env and configure.

pnpm --filter @nexus/browser-worker-host build
node -e "import('@nexus/browser-worker-host').then(m => m.runBrowserWorkerHost())"
```

---

## Security

| Property                      | Implementation                                                     |
| ----------------------------- | ------------------------------------------------------------------ |
| No shared secrets with Core   | Ed25519 challenge signing; private key never traverses network     |
| Two links, two secrets        | Python worker token never crosses into Core boundary               |
| No inbound listening ports    | `connect()` exists, `listen()` does not — verified by test         |
| No process execution          | Neither `child_process` nor `exec` — verified across entire source |
| Single disk access            | Device private key in `link.ts` — verified across entire source    |
| No generic capabilities       | Four explicitly named capabilities, none accept arbitrary actions  |
| URL scheme restriction        | Only `http`/`https`; `javascript:`, `file:`, `data:` rejected      |
| Cleartext remote links banned | Enforced for both Core connection and Python worker connection     |
| Secrets excluded from logs    | `describeConfig()` masks values, exposing only keys and presence   |
| CAPTCHA, MFA                  | Never bypassed — triggers `BROWSER_NEEDS_HUMAN`, non-retryable     |
| Model chain-of-thought        | Truncated to 120 characters in progress reports                    |

---

## Tests

```bash
pnpm --filter @nexus/browser-worker-host test          # 51 tests, without Python

NEXUS_WORKER_PYTHON=services/browser-worker/.venv/Scripts/python.exe \
  pnpm --filter @nexus/browser-worker-host test        # + 4 end-to-end tests
```

The only test double is the Python worker, replaced **at the HTTP boundary**: the client
realistically serializes requests, parses responses, and interprets status codes. Everything
else is real — valid Ed25519 keys, real `WorkerGateway`, real `DeviceSessionService`, and
genuine protocol envelope validation.

---

## Known Limitations

1. **No real browser is driven during automated CI.** End-to-end tests launch the real Python
   worker and prove the entire communication chain up to it; they do not invoke `browser-use`
   or Chromium directly (which require live LLM credentials and external internet access). The
   Python worker maintains its own `-m browser` test suite for full browser driving.
2. **`packages/browser-client` still exports `createBrowserTools`**, the legacy direct path
   (`browser.read/interact/login/purchase` tools calling the Python worker without Core routing).
   It is unreferenced in default configurations. The canonical path is through this package.
3. **Three transport adapters coexist** — one per worker type (`ws` + TLS pinning for Windows,
   React Native `WebSocket` for Android, Node `WebSocket` here). Business logic is not duplicated:
   it resides entirely in `WorkerRuntime`. Consolidating into `@nexus/worker-node` is possible
   in future refactorings.
4. **No Core certificate pinning in Node host.** `NEXUS_CORE_FINGERPRINT` is parsed by configuration,
   but Node's default `WebSocket` client does not expose `checkServerIdentity`. This host runs
   alongside the Core on internal infrastructure; the Windows worker, traversing public networks,
   strictly enforces pinning.
