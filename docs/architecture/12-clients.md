# 12 — Clients: Mobile, Desktop, and Web

## 1. Common Foundation

All three clients share `@nexus/sdk-client`: typed REST client, WebSocket connection manager
(auto-reconnect, `seq` replay, offline dispatch queue), agent run state machine, and local cache. A
client knows **neither backend tools, nor LLM providers, nor the database**. It knows conversations,
messages, streaming events, and confirmation prompts (Constraint C4).

State Management: **TanStack Query** for server-state caching, **Zustand** for interactive client
state (active run state, streaming token buffers, audio recording lifecycle). High-frequency streaming
deltas are kept out of Query cache to avoid rendering bottlenecks.

## 2. Mobile (Expo / React Native)

**Stack**: Expo SDK (managed + development build), Expo Router, `react-native-reanimated`,
`expo-av` (audio capture), `expo-secure-store` (tokens), `expo-notifications` (push),
`react-native-mmkv` (local storage), Nativewind / StyleSheet + `@nexus/ui-tokens`.

**Screens**

| Screen         | Key Contents                                                                               |
| -------------- | ------------------------------------------------------------------------------------------ |
| Conversation   | Message timeline, streaming tokens, tool cards, confirmation cards, text + mic composer   |
| History        | Conversation list, search, pinning, archiving                                              |
| Tasks          | Active and scheduled missions, progress tracking, result summaries                         |
| Devices        | Paired machines, online status, QR enrollment, audit logs, revocation                      |
| Permissions    | Tool grants, path scopes, instant revocation, audit log viewer                             |
| Memory         | Long-term memory facts, inline editing, manual deletion                                     |
| Settings       | Provider configurations, voice models, cost budgets, privacy toggles                       |

**The Conversation Timeline** is the core product interface. It renders an **event timeline**, not
merely static chat bubbles:

```
┌──────────────────────────────────────────┐
│ 👤 Check my inbox and highlight          │
│    important emails                       │
├──────────────────────────────────────────┤
│ ✳ Thinking…             (animated pulse)  │
│ ▸ Plan  1. read  2. classify  3. digest  │
│ 🔧 mail.list          ✓ 1.2s   34 emails │
│ 🔧 mail.read          ⟳ 12/34  ▓▓▓░░░    │
│ ┌──────────────────────────────────────┐ │
│ │ ⚠️ Confirmation Required              │ │
│ │ mail.send → recruiter@example.com    │ │
│ │ Subject: Re: Proposal                │ │
│ │ "Hello, thank you for your note..."  │ │
│ │        [ Reject ]  [ Send ]          │ │
│ └──────────────────────────────────────┘ │
│ 🤖 You have 3 important emails: …        │
│    (streaming text output)                │
└──────────────────────────────────────────┘
```

Non-Negotiable UI Principles:

1. **Every real-world action is visible.** A tool card renders for every execution, highlighting risk
   tier, duration, and status. Users never discover post-hoc what actions were taken.
2. **Confirmation cards show exact payloads**, not summaries — full email drafts, exact file diffs,
   or shell commands with working directories. Collapsible for comfortable viewing.
3. **Distinct waiting states**: "Thinking", "Executing tool X", and "Waiting for your input" feature
   three distinct visual indicators. A generic spinner makes the assistant opaque.
4. **Cancellation is always one tap away** throughout the entire run lifecycle.
5. **Optimistic and offline-tolerant**: User messages appear locally immediately with a `clientMessageId`,
   reconciling on server `ack`, and retrying upon reconnection.

**Push Notifications**: When the app is backgrounded, pending confirmations and completed runs trigger
push alerts. A standard `CONFIRM` prompt can be approved directly via notification actions; a `CRITICAL`
action strictly requires opening the app and completing biometric re-authentication.

## 3. Desktop (Tauri v2)

**Choice**: Tauri v2 rather than Electron (→ [ADR-008](../adr/ADR-008-desktop-tauri.md)) — ~10 MB
binary vs. ~120 MB, significantly lower memory footprint, explicit security capability model, and an
underlying Rust foundation suited for host controller tasks (tray icon, process supervision).

Known trade-off: Host OS webviews differ slightly (WebView2 on Windows, WKWebView on macOS, WebKitGTK
on Linux). Mitigated by clean, functional UI styling without exotic CSS properties, prioritizing
Windows first, followed by macOS.

**Dual Purpose**:

1. **Chat Client** — Shares identical React UI components with the web dashboard.
2. **Device Agent Shell** — Installs, supervises, and monitors the background Node daemon (→ [06](06-devices.md)):
   online status, running tasks, live logs, local policy editor, and an emergency "pause" button that
   immediately freezes local execution.

**Native OS Integrations**: Global hotkey invocation, spotlight quick-entry window, system tray menu,
desktop notifications, launch on boot, and deep-link handling.

## 4. Web Dashboard

Vite + React, sharing components with the desktop shell. Addresses two needs: quick access from
un-enrolled browsers and administrative supervision. Features no device-agent capabilities.
Enforces strict CSP, ephemeral tokens in memory, and rotating refresh tokens inside `HttpOnly`
`SameSite=Strict` cookies (the only place cookies are used), avoiding `localStorage` refresh storage.

## 5. Shared vs. Platform-Specific Code

| Shared Components                       | Platform-Specific Implementations      |
| --------------------------------------- | -------------------------------------- |
| `@nexus/contracts`, `@nexus/sdk-client` | React Native native views vs. DOM HTML |
| Run state machine, event reducers       | Navigation stacks, gesture animations  |
| Design tokens (`@nexus/ui-tokens`)      | Low-level component wrappers           |
| Validation schemas, error taxonomies    | Audio recording, biometric storage     |

We do **not** use `react-native-web`. We share business logic, hooks, and contracts, while maintaining
clean platform-native presentation layers.

## Offline Handling, Auto-Updates, and Crash Telemetry

### Offline Queue: Preventing Duplicate Actions

An unconstrained offline queue risks doubling user actions. A user sends "clean up my inbox", loses
network before the response arrives, and reconnects — sending the command twice.

Three strict rules prevent duplicate execution:

**Idempotency Keys Generated at Queue Time, Not Dispatch Time.** Subsequent network retry attempts
carry the identical token, allowing the backend to recognize repetitions.

**Only Deduplicated Routes Can Be Queued.** Only routes that explicitly support `Idempotency-Key` are
eligible for offline queueing. On unsupported endpoints, offline queueing would guarantee duplicate
mutations; the client therefore rejects queueing and informs the user immediately.

**Time-to-Live Expiration.** Queue items expire after 24 hours. An intent whose temporal context has
expired must not execute stale actions ("reply to this urgent message" queued Tuesday makes no sense on Friday).

**Confirmation Prompts Are Never Queued Offline.** Approving a mutating action offline to dispatch
hours later is dangerous. Confirmations must be reviewed and authorized in real time against active state.

Queue processing respects strict sequence order, halting on the first retryable network error to
preserve message causality. Definite 4xx rejections are discarded to prevent queue head-of-line blocking.

### Automatic Updates: Deciding, Never Executing

`UpdatePolicy` evaluates release version feeds and reports whether an update is available. It downloads,
installs, and executes nothing — that responsibility belongs strictly to the platform host (Tauri on
desktop, app stores on mobile), which holds the public key validating package signatures.

Safety Rules:

| Rejection Case          | Rationale                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Unsigned bundle         | An unsigned package is untrusted: whoever serves it could inject arbitrary malicious code |
| Version downgrade       | Downgrade attacks could reintroduce previously patched security vulnerabilities            |
| Channel switching       | Stable production installs must not jump to beta channels without explicit user intent    |
| Major version upgrades  | Breaking changes require database or config migrations; never auto-applied silently        |

Malformed feed entries are ignored rather than failing the evaluation, ensuring feed issues do not
block critical security patch installations.

### Crash Telemetry: Strictly Local, Zero Outbound Network Calls

Crash dumps are written **locally on the workstation**. Nothing is transmitted to external telemetry
servers: zero third-party endpoints, zero telemetry API keys, zero outbound network queries. A crash
trace contains file paths, conversation snippets, and runtime context — transmitting this by default
violates user privacy.

The `share()` helper exports an explicitly redacted summary that the user can inspect before sharing.
The module contains no networking dependencies, verified by unit tests.

Three safeguards are enforced:

- **Strict Redaction**: Uses the centralized regex redaction engine across error messages, stack traces,
  and context metadata;
- **Disk Bounding**: Crash loops could otherwise generate thousands of dumps and fill disk space;
  reports are strictly bounded;
- **Deduplication**: Repeated identical stack traces increment an occurrence counter rather than
  appending redundant dump files.
