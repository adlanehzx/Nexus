# Apple Watch and Wear OS Companion Feasibility Study

## 1. Executive Summary

This study documents the technical feasibility, architectural constraints, security boundaries, and
implementation plan for NEXUS companion applications targeting **Apple Watch (watchOS 10+)** and
**Wear OS (Wear OS 4+, Android API 33+)**.

The companion is **not** a standalone AI assistant: running full language models or complex graph
orchestration locally on smartwatch hardware is infeasible due to extreme thermal, memory, and battery
ceilings. Instead, the companion is a **bounded remote interface** to the paired host (phone or local
workstation) optimized for glanceable status, urgent approvals, and one-tap or hands-free actions.

## 2. Hardware and Platform Constraints

| Dimension                  | Apple Watch (watchOS 10+)                                                            | Wear OS (Wear OS 4 / 5)                                               | NEXUS Design Decision                                                               |
| :------------------------- | :----------------------------------------------------------------------------------- | :-------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| **Max App Memory**         | 35 MB – 50 MB before watchdog kill                                                   | ~64 MB heap limit                                                     | Lean lightweight client; no heavy in-memory graph models.                           |
| **Background Execution**   | Highly restricted (sessions, complications, background refresh up to 4x/hour)        | Doze mode, limited foreground services, strict battery optimizations  | Push-driven notifications + short-lived sync on app launch.                         |
| **Network Transport**      | WatchConnectivity (WCSession) over Bluetooth LE / WiFi, direct HTTPS when untethered | Wearable Data Layer API (MessageClient / ChannelClient) over BLE/WiFi | Scoped companion protocol over platform bridge; direct fallback when phone absent.  |
| **Input Modality**         | Digital Crown, touch targets >= 44x44 pt, Siri/Dictation                             | Touch, rotary dial, speech recognition                                | Minimized interaction: binary decision (Approve/Reject) or quick voice query.       |
| **Biometric Confirmation** | Wrist detect, passcode, double-tap gesture                                           | PIN/pattern, biometric prompt (fingerprint on selected models)        | Hardware-backed presence; sensitive actions require explicit physical confirmation. |

## 3. Bounded Companion Scope

Smartwatch companion capabilities are strictly bounded:

### In Scope

1. **Glanceable Complications / Tiles**:
   - Current mission status (Running, Waiting Confirmation, Idle, Failed).
   - Unread system alerts count.
2. **Actionable Confirmations**:
   - Approve or Reject step with single physical touch.
   - Irreversible actions (destructive deletions, fund movements, public network access) are **never** approved from a watch complication.
3. **Quick Voice Dictation**:
   - Single-turn query or command forwarded immediately to phone or server.
4. **Emergency Stop / Abort**:
   - Instantly halt the active mission running on any paired device.

### Out of Scope (Explicitly Excluded)

1. Full DAG visualization or complex log streaming (unreadable on small screens).
2. Permanent credential or master secret storage on watch.
3. Device pairing management or administrative key rotation.
4. Autonomous agent execution without phone or server connection.

## 4. Security and Isolation Architecture

1. **Scoped Companion Tokens**:
   - Smartwatch receives an ephemeral scoped token issued by the paired phone.
   - Scope is restricted to `companion:glance`, `companion:approve`, and `companion:voice_input`.
   - Cannot issue administrative commands (`auth:*`, `devices:revoke`, `keys:export`).
2. **Secure Enclave / Keystore**:
   - iOS: Stored in Apple Watch Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
   - Wear OS: Stored using `EncryptedSharedPreferences` backed by Android Keystore.
3. **Immediate Revocation**:
   - Unpairing the mobile app or revoking the mobile device immediately invalidates all watch companion sessions.
   - Watch tokens expire after 24 hours of inactivity.
4. **Zero-Retention on Device**:
   - Audio recordings transcribed or streamed are never stored permanently on the smartwatch file system.

## 5. Implementation Model

The companion implementation in `@nexus/client-core` (`packages/client-core/src/companion/watch.ts`)
provides a typed, platform-neutral contract consumed by native watchOS and Wear OS bridges:

- `WatchGlanceState`: compact summary for complications and widgets.
- `WatchApprovalRequest`: pending action requiring confirmation with impact level.
- `WatchCompanionManager`: token validation, bounded action dispatch, and automatic expiration.
