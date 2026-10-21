# @nexus/worker-core

Shared execution runtime across all NEXUS worker nodes: connection lifecycle, capability registry,
step execution, cancellation, and task resumption.

**Status: Implemented and tested.** 23 package unit tests, plus 319 integration tests across
Windows and Android workers exercising the runtime end-to-end.

---

## Architectural Purpose

The Windows worker and Android worker share core execution logic: challenge handshakes, capability
registration, heartbeats, argument schema validation, timeouts, cooperative cancellation, idempotency,
and reconnection routines.

Duplicating this logic would create redundant capability registries and dual lifecycles, guaranteeing
that fixes applied to one platform would diverge from the other. This package provides the unified foundation:

```
              @nexus/worker-core
     (Lifecycle · Registry · Execution · Resumption)
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
   services/windows-worker    services/android-worker
     Node Ports                 Android Ports
```

---

## Platform Port Requirements

Platform adapters implement three specific ports:

| Port Interface     | Responsibility                      | Windows Node Provider | Android Mobile Provider      |
| ------------------ | ----------------------------------- | --------------------- | ---------------------------- |
| `CredentialSigner` | Cryptographic challenge signing     | Ed25519 PEM key file  | Hardware KeyStore, NIST P-256|
| `HealthSource`     | System health and saturation status | `node:os` metrics     | Battery level, power saver   |
| `TimerPort`        | Task and heartbeat timers           | Native `setTimeout`   | Injected timer interface     |

All remaining execution mechanics are identical.

---

## Hermes and Node Portability

**This package imports zero Node.js native runtime APIs.** It executes seamlessly on Node.js _and_
on Hermes (the React Native Android JavaScript engine). A single `node:*` import would break the Android
worker bundle, triggering crashes on physical mobile devices.

Automated CI tests statically scan the codebase to enforce zero Node runtime imports.

---

## API Overview

| Component                             | Role                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `WorkerRuntime`                       | Complete lifecycle: connect, authenticate, register, heartbeats, execute, resume           |
| `LocalCapabilityRegistry`             | Machine capabilities catalog, including runtime availability probes                         |
| `LocalCapability`                     | Capability contract: input schema, risk level, health probe, execution logic                |
| `TaskRunner`                          | Step execution pipeline: schema parsing, timeout racing, cancellation, output validation    |
| `WorkerLink` · `LoopbackLink`         | Transport port interface alongside its in-memory testing implementation                      |
| `Backoff`                             | Exponential backoff calculation with upper-half jitter                                      |
| `WorkerLogger` · `MemoryWorkerLogger` | Redacted structured logging engine                                                          |

### Security Capabilities

```ts
interface LocalCapability {
  /** The central core transmits this result to client interfaces without persisting it in audit logs. */
  sensitiveResult?: boolean;
  /** Explicit argument fields to redact before persisting to logs. */
  secretArguments?: readonly string[];
}
```

`sensitiveResult` protects visual artifacts like screenshots: redacting text inside a raster image
is not viable, so raw bitmap results are omitted from long-term database logs.
`secretArguments` handles text input fields: automated redaction filters recognize keys like `password`
and `token`, but cannot anticipate whether a generic field named `text` carries a private secret.
The capability specifies which parameters require redaction.
