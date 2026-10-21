# @nexus/devices

Multi-device architecture: registry, device selection, distributed task plans, event routing,
and cryptographically authenticated sessions.

**Status: Core implemented and tested.** 67 tests. Physical executors (Windows worker, Android automation,
mobile chat clients) do **not** live in this package — they attach to it over typed protocols.

---

## Architectural Principle

```
                    DeviceRegistry          "Who exists, what can it do"
                          │
 TaskPlan ─▶ TaskCoordinator ─▶ DeviceSelector ─▶ WorkerTransport ─▶ Worker
                    │              "Which device?"
                    └──▶ EventRouter ─▶ All user clients (Originating device first)

 Capability ─▶ createDeviceTools ─▶ ToolDefinition ─▶ ToolRegistry ─▶ Agent Core
```

**The core never identifies devices by name.** It recognizes roles, hardware types, and advertised capabilities.
Device names are database records, never hardcoded conditionals. Additionally, there is **no secondary tool system**:
a device capability maps into a standard `ToolDefinition`, exactly mirroring the `@nexus/mcp` pattern.

---

## Enrolling a Device

Requires zero codebase modifications. Three database insertions:

```ts
const device = await registry.registerDevice({
  userId,
  name: "Primary Workstation", // Friendly label, never inspected by routing logic
  type: "WINDOWS_PC",
  platform: "WINDOWS",
  role: "BOTH", // Client interface AND task worker
  capabilities: [
    {
      name: "terminal.execute",
      version: "1",
      description: "Shell Execution",
      enabled: true,
      metadata: {},
    },
    { name: "git.execute", version: "1", description: "Git Operations", enabled: true, metadata: {} },
  ],
  grantedPermissions: ["terminal.execute", "git.execute"],
});

// Enrolled in OFFLINE and PENDING state: trust is explicitly granted, never assumed.
await registry.trustDevice(device.id);
```

The device authenticates (see below) and streams heartbeats. It becomes eligible for task selection
once `ONLINE`, `TRUSTED`, and authenticated.

To expose device capabilities to the LLM agent:

```ts
toolRegistry.registerAll(
  createDeviceTools({
    registry: deviceRegistry,
    selector,
    transport,
    specs: standardDeviceToolSpecs(),
  }),
);
```

---

## Role, Type, and Capability

| Axis           | Semantics                             | Allowed Values                                                           |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| **Role**       | Is the machine authorized to execute? | `CLIENT` · `WORKER` · `BOTH`                                             |
| **Type**       | What platform/architecture is it?     | `IPHONE` · `ANDROID` · `WINDOWS_PC` · `MAC` · `LINUX` · `BROWSER_WORKER` |
| **Capability** | What actions can the machine perform? | `terminal.execute`, `filesystem.read`, `android.notification`…           |

A `CLIENT` is never assigned task execution, even if it advertises capabilities. Device role takes precedence.

Capabilities share the permission namespace (`domain.action`). A capability declares what the machine
_can_ do; a permission grant declares what the user _permits_ — both must be satisfied.

---

## Device Selection

`DeviceSelector` filters candidates, then scores survivors. Filters run in diagnostic order:
explicit exclusions, role check, revocation status, trust status, health, required capabilities,
permission grants, device saturation, and constraints (type, platform, AC power).

Every rejection includes a specific reason — `selection.rejected` answers "why wasn't this device chosen?"
without code instrumentation.

Survivors are scored: Explicit User Preference (1000) ≫ Availability (300) > Health (200) > Latency (150)
> AC Power (100) > Specialization (50). User preferences override rankings, **never hard security filters**.

---

## Task Plans

`TaskPlan` ≠ `AgentRun`. An agent run describes autonomous model reasoning; a task plan describes distributed
multi-device execution. The step graph is validated at construction — duplicate IDs, dangling dependencies,
and dependency cycles are rejected immediately.

```ts
const plan = createTaskPlan({
  userId,
  title: "Clone, test, and notify",
  originClientDeviceId: iphone.id, // Routing thread
  correlationId,
  steps: [
    {
      id: "clone",
      description: "Clone repository",
      requiredCapabilities: ["git.execute"],
      tool: "device.git.execute",
      arguments: { command: "clone …" },
    },
    {
      id: "test",
      description: "Run test suite",
      requiredCapabilities: ["terminal.execute"],
      tool: "device.terminal.execute",
      arguments: { command: "pnpm test" },
      dependsOn: ["clone"],
    },
    {
      id: "notify",
      description: "Send push notification",
      requiredCapabilities: ["android.notification"],
      tool: "device.android.notification",
      arguments: { title: "Tests Complete" },
      dependsOn: ["test"],
    },
  ],
});

await coordinator.execute(plan, { userPermissions });
```

Ready steps execute **in parallel**. Steps whose dependencies fail transition to `skipped`, not `failed`:
they did not fail, they never ran. The overall plan marks `partial` — a distinct status indicating
partial completion.

---

## Event Routing

The originating client receives events **first**; all other active user sessions receive them subsequently.
A reconnecting client retrieves missed events upon attachment:

```ts
const backlog = await router.attach({ deviceId, userId, send });
```

The queue is **bounded** (200 events per device). Excess events are discarded: clients absent for days
perform a full state resynchronization upon return rather than replaying large historical event logs.

**Zero peer-to-peer sync.** All traffic routes through the central server, preventing split-brain states.

---

## Security

- **Device IDs Never Authenticate Traffic.** They are public strings. Sessions originate from signed Ed25519 challenges:

  ```ts
  const challenge = await sessions.createChallenge(deviceId);
  const { session, token } = await sessions.authenticate(
    { deviceId, nonce: challenge.nonce, signature, capabilities },
    publicKeyMaterial,
  );
  // `token` is returned only once; only its hash is persisted at rest.
  ```

- Nonces are consumed **even when signatures fail** to prevent replay attacks.
- Negotiated capabilities are **bounded by registered capabilities**: sessions cannot claim more than
  the device record allows.
- `assertNotReplayed(requestId, timestamp)` rejects replayed requests.
- Trust ≠ Status. `PENDING` = online, yet assigned zero tasks. `revokeTrust` is reversible; `revokeDevice` is permanent.
- Capabilities are **re-verified immediately prior to task dispatch**.
- **Never Logged**: Passwords, API tokens, cookies, private keys. Task executions sanitize arguments
  via `@nexus/shared` `redact`; event envelopes carry zero raw arguments.

---

## API Overview

| Component                   | Purpose                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `DeviceRegistry`            | Registration, capabilities, health probes, trust status, heartbeats              |
| `DeviceSelector`            | `select` · `trySelect` · `listEligible`                                          |
| `TaskCoordinator`           | Executes `TaskPlan`: selection, confirmation gates, dispatch, retry, failover    |
| `EventRouter`               | `attach` · `detach` · `emit` · `publish` · `sendTo` · `pendingFor`               |
| `DeviceSessionService`      | Challenges, asymmetric authentication, token rotation, revocation, anti-replay    |
| `createDeviceTools`         | Capability → `ToolDefinition` adapters for central `ToolRegistry`                |
| `DeviceStore` · `TaskStore` | Persistence port interfaces (in-memory implementations included)                 |

---

## Troubleshooting Diagnostics

| Symptom                        | Probable Cause                                                     |
| ------------------------------ | ------------------------------------------------------------------ |
| `NoEligibleWorkerError`        | Check `rejected` array: lists explicit rejection reasons per device|
| Device never selected          | `trust` still in `PENDING` state, or `authenticated: false`        |
| Device transitions offline     | Zero heartbeats received within `heartbeatTimeoutMs` window (60s)  |
| Client receives zero events    | Configured as `WORKER` role: workers do not receive broadcast logs |
| Task plan finishes `partial`   | A prerequisite step failed, causing dependent steps to be skipped  |
