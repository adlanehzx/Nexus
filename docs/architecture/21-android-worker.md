# 21 — Android Worker (Implemented Architecture)

Describes the Android Worker subsystem **as built in the codebase**. Packages:
[`@nexus/android-worker`](../../services/android-worker) and
[`@nexus/worker-core`](../../packages/worker-core).

## 1. What Was Delivered

`TaskCoordinator`, `DeviceSelector`, `TaskPlan`, `WorkerGateway`, `PermissionService`, and
`ConfirmationService` remain **completely unchanged**. Connected mobile devices appear to the system
as standard execution nodes.

Three specific additions were introduced:

1. **`@nexus/worker-core` was extracted** from the Windows worker. Duplicating worker lifecycle logic
   and capability registries would have introduced divergence between platform workers.
2. **`ecdsaP256Verifier` was added** to `DeviceSessionService`: Android hardware keystores support
   NIST P-256 rather than Ed25519.
3. **`sensitiveResult` and `secretArguments`** were added to capability contracts: screenshot outputs
   must not persist in central audit logs, and input fields named `text` may contain passwords.

## 2. One Shared Runtime Across Platforms

```
              @nexus/worker-core
     (Lifecycle · Registry · Execution · Resumption)
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
    Windows        Android      (Future Workers)
    Node Ports    Android Ports
```

The Windows worker and Android worker run **identical logic** for handshakes, enrollment, heartbeats,
step execution, idempotency, and task resumption. Platform-specific differences are encapsulated
in three ports — signature verification, health checks, and timers — alongside platform capabilities.

Verified by test suites: all 174 Windows worker tests passed unchanged following core extraction.

## 3. Platform Capabilities and Permissions

Android prohibits arbitrary remote control. Every capability maps to public Android APIs and
explicit user permissions — detailed in [`services/android-worker/README.md`](../../services/android-worker/README.md).

Two key platform decisions:

- **`QUERY_ALL_PACKAGES` is not requested.** A `<queries>` manifest entry targeting launchable main
  activities provides application launch capabilities without requesting invasive full-device software inventories.
- **`MediaProjection` was avoided** in favor of `AccessibilityService.takeScreenshot()`: on-demand
  single-frame image capture rather than an invasive continuous video stream.

## 4. Dynamic Capability Fluctuation

Workstation capabilities rarely change while online. On mobile devices, capabilities change dynamically:
a user may temporarily toggle off accessibility services when lending their device.

`AvailabilityWatcher` periodically verifies service availability and updates advertised capabilities
via `worker.register`, triggering `device.capabilities_changed` on the server when the list changes.
This prevents the selector from dispatching touch actions to a device that has disabled accessibility access.

## 5. Graceful Degradation Under Resource Pressure

A mobile device at 8% battery remains reachable, but should avoid receiving non-essential background
tasks. `AndroidHealthSource` reports throttled capacity under low battery states, allowing the central
selector to recognize device saturation naturally.

## 6. Closing Potential Data Leaks

- **Screenshots**: Raw screenshot bitmaps could inadvertently persist inside `TaskExecution.result`
  for months. The capability marks `sensitiveResult`: image data streams to the client interface while
  central audit logs retain only summary metadata.
- **Text Inputs**: Redaction engines mask fields named `password` or `token`, but cannot know whether
  a generic field named `text` carries sensitive content. The capability declares `secretArguments: ["text"]`,
  ensuring input text is masked in audit trails.

## 7. Operational Validation Status

The Kotlin service layer is designed and written; physical validation against real hardware devices
follows the operational checklists documented in the package README.
