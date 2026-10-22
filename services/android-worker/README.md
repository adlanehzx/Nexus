# @nexus/android-worker

Android worker: controlled local capabilities with an **outbound** connection to the
NEXUS Core.

**Status: Complete Android application verified on emulator.** 188 automated tests,
`./gradlew assembleDebug` builds the APK, and all seven capabilities have been verified
against a live Core on a Pixel 8 emulator (API 36).
**No tests have been executed on the physical Redmi Note 10S yet** — see §Known Limitations.

The mobile phone functions strictly as a **worker**, not a client. The user drives NEXUS
from the desktop application or browser client.

---

## Principle

```
Android Worker ──(Outbound WebSocket, wss://)──▶ NEXUS Core
                                                   │
                                            WorkerGateway
                                                   │
                                  TaskCoordinator ◀── DeviceSelector
                                                   │
                                                 Agent
```

The phone initiates outbound connections to the Core; the Core cannot connect to a phone.
No inbound ports, no port forwarding, and no direct client-to-device communication.

Nothing in this codebase is hardcoded to a specific phone model: it operates as a standard
device record with type `ANDROID` and role `WORKER`.

---

## Shared Architecture with Other Workers

|                                                  | Source                                                      |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Lifecycle, handshake, reconnect, heartbeats      | `@nexus/worker-core` — **identical code to Windows worker** |
| Capability registry, step execution, idempotency | `@nexus/worker-core`                                        |
| Authentication, sessions, anti-replay            | `DeviceSessionService` from `@nexus/devices`, unmodified    |
| Wire protocol, event framing                     | `@nexus/protocol`, unmodified                               |

This package only introduces Android-specific adaptations: four Android ports, three security
policies, seven capabilities, battery status monitoring, and availability checks.

---

## Android Security Constraints

Android deliberately prohibits arbitrary remote control. This worker does not attempt to
circumvent these OS sandboxing principles; it bases its architecture upon them.

| Capability              | Android Mechanism                             | Permission                         | Granted by                                                      |
| ----------------------- | --------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `android.app.list`      | `queryIntentActivities`                       | `<queries>` on `MAIN`/`LAUNCHER`   | App manifest, no user action required                           |
| `android.app.open`      | `getLaunchIntentForPackage` + `startActivity` | — (+ background start exemption)   | Active accessibility service or OEM background popup permission |
| `android.ui.click`      | `AccessibilityNodeInfo.ACTION_CLICK`          | `BIND_ACCESSIBILITY_SERVICE`       | **User**, Settings → Accessibility                              |
| `android.ui.input`      | `ACTION_SET_TEXT`                             | same                               | same                                                            |
| `android.ui.scroll`     | `ACTION_SCROLL_*` / `dispatchGesture`         | same                               | same                                                            |
| `android.ui.screenshot` | `AccessibilityService.takeScreenshot()`       | same + Android 11+                 | same                                                            |
| `android.notification`  | `NotificationManager.notify()`                | `POST_NOTIFICATIONS` (Android 13+) | User prompt upon request                                        |

### `QUERY_ALL_PACKAGES` Is Not Requested

Since Android 11, package visibility is restricted. While a broad query permission exists,
it requires special Google Play justification and exposes the complete software inventory of the
device. Instead, the manifest declares an intent query matching launchable activities only:
discovering launchable apps and nothing else.

### `MediaProjection` Was Rejected

|                    | `takeScreenshot()`                      | `MediaProjection`           |
| ------------------ | --------------------------------------- | --------------------------- |
| Permission         | Accessibility Service (already granted) | Dedicated system dialog     |
| Scope              | **Single frame upon discrete call**     | Continuous video capture    |
| Token              | None                                    | Retained after capture      |
| Foreground service | No                                      | Yes, permanent notification |

`MediaProjection` yields continuous streaming; NEXUS requires point-in-time screenshots.
Relying on it would establish persistent screen recording privileges for intermittent needs.
Trade-off: On Android 10 and below, screenshot capabilities cannot be advertised. Android 11+
is required.

### Ed25519 in Android Keystore

Android Keystore historically lacked support for Ed25519 keys. The architectural choice was
between a **software** Ed25519 key (consistent with other workers, but extractable from storage)
or a **hardware-backed ECDSA P-256 key** in Android Keystore. NEXUS prioritizes hardware isolation
and non-extractability.

`DeviceSessionService` supports pluggable verifiers: `ecdsaP256Verifier` sits alongside
`ed25519Verifier`, and `DeviceCredential.kind` supports `ECDSA_P256_PUBLIC_KEY`. This is not a
divergent authentication system: challenge generation, session tokens, rotation, and anti-replay
logic remain identical; only the signature validation primitive differs.

---

## Building the APK

Prerequisites: JDK 17, `ANDROID_HOME` configured. Gradle 8.14.3, Android build tools, and Android
Platform 36 download automatically.

```bash
pnpm install

# 1. Configure nexus.config.json: Core URL, DEVICE_ID, enabled capabilities.
#    NO SECRETS ARE STORED HERE — the device key is referenced by an ALIAS
#    in Android Keystore and never leaves the hardware.

# 2. Build.
cd services/android-worker/android
./gradlew assembleDebug          # armeabi-v7a + arm64-v8a (target phones)

# For x86_64 emulators, specify architecture:
./gradlew assembleDebug -PreactNativeArchitectures=x86_64

# 3. Output APK: app/build/outputs/apk/debug/app-debug.apk
```

Debug builds load JavaScript from Metro (`node node_modules/react-native/cli.js start`, then
`adb reverse tcp:8081 tcp:8081`). `assembleRelease` produces standalone bundles; output is
unsigned until a private release keystore is provided outside the repository.

---

## Installation

### Published APK (Recommended)

1. Install the signed APK from the official NEXUS release assets.
2. In the dashboard, open **Devices**, click **Create Pairing Code**, and select **Copy Android Link**.
3. On first launch of the worker app, paste the pairing link and tap **Pair**.
4. Return to the dashboard and approve the pending device.

The same universal APK works on all devices: no URLs or personal credentials are baked into the binary.
The ECDSA P-256 key is generated inside Android Keystore; only the public certificate is registered
with the Core.

### From Source

```bash
# 1. Register device on Core: type ANDROID, role WORKER.
#    Backend allocates DEVICE_ID and permissions.

# 2. Install APK on phone.

# 3. Open NEXUS Worker. Management screen displays the public key
#    (ECDSA P-256 generated in Keystore on first launch):
#    submit public key to backend and approve the device.

# 4. Grant permissions in Android Settings:
#    - Accessibility Service -> Settings -> Accessibility -> NEXUS Worker
#    - Notifications         -> Settings -> Apps -> NEXUS Worker

# 5. Disable vendor-specific battery killers (MIUI / HyperOS / Samsung):
#    - Autostart               -> Enable
#    - Battery Saver           -> "No restrictions"
#    - Display popup in background -> Enable
```

`.env.example` contains placeholders only — verified by test. Device credentials are referenced
strictly via keystore alias.

---

## Security

- **Device IDs never authenticate.** A fresh cryptographic challenge is signed on every connection.
- **No generic entry points.** `ports.ts` exhaustively enumerates what JavaScript may request from
  the Android OS: no arbitrary `Intent` broadcasting, no shell execution, no arbitrary reflection.
- **`android.app.open` accepts package names only**, checked by format and filtered by a strict blocklist.
  System settings, package installers, crypto wallets, and password managers are blocked unconditionally.
- **Coordinate-based clicking is disabled by default.** Coordinate clicks hit whatever pixel is positioned
  at the coordinates rather than semantically resolved UI elements.
- **Input text is never logged or leaked**: `android.ui.input` declares `secretArguments: ["text"]`,
  ensuring full redaction across logs, events, and task output.
- **Screenshots are never persisted to disk or logged**: `sensitiveResult` ensures execution logs retain
  only metadata references without writing image data to disk.
- **Screen capture rate limiting** prevents continuous unauthorized video harvesting.
- **Runtime availability checked per call**: if the user disables Accessibility mid-task, execution halts.
- **Zero implicit trust in Core**: the worker enforces local restrictions independently of Core requests.

### Excluded Capabilities by Design

Notification reading · continuous video recording · microphone access · camera access · SMS ·
contacts · location · `QUERY_ALL_PACKAGES`. Automated security tests scan code and manifest files
to prevent accidental introduction.

---

## Health and Battery States

A battery at 8% remains online, but UI automation would quickly drain the device and disable alarms.

| Battery Level                    | Status       | Behavioral Effect                                                      |
| -------------------------------- | ------------ | ---------------------------------------------------------------------- |
| > 20%, or plugged in / charging  | Normal       | Accepts standard tasks                                                 |
| ≤ 20% on battery, or Power Saver | **Degraded** | Advertised task capacity throttled to 1; selector prefers alternatives |
| ≤ 10% on battery                 | Saturated    | Rejects all new tasks                                                  |

No additional private telemetry is reported: no GPS coordinates, no Wi-Fi SSIDs, no hardware serials.

---

## Physical Hardware Verification Checklist

**The following items require physical verification on test hardware.** Automated test suites
verify logic via emulators; physical hardware behavior (especially vendor background execution
restrictions) must be verified before production deployment:

| #   | Step                                   | Expected Behavior                                      |
| --- | -------------------------------------- | ------------------------------------------------------ |
| 1   | Install APK                            | Application boots cleanly                              |
| 2   | Pair device with NEXUS                 | Public key renders, Core accepts registration          |
| 3   | Approve device in Core                 | Status transitions to `TRUSTED`                        |
| 4   | Grant notification permissions         | Status indicator updates to granted                    |
| 5   | Enable Accessibility Service           | Status updates; UI capabilities register               |
| 6   | Verify screenshot permission           | Status updates to granted (Android 11+)                |
| 7   | Start worker daemon                    | Status shows "Ready"                                   |
| 8   | Inspect Core dashboard                 | Device displays as `ONLINE`                            |
| 9   | Verify advertised capabilities         | All 7 capabilities reported                            |
| 10  | `android.app.open` (Spotify)           | Target app opens in foreground                         |
| 11  | `android.ui.screenshot`                | Legible PNG image returned to client                   |
| 12  | `android.ui.click` on identified node  | Node tap successfully dispatched                       |
| 13  | `android.ui.input` in text input field | Text populated; verify absent from all logs            |
| 14  | `android.ui.scroll`                    | Viewport scrolls accordingly                           |
| 15  | `android.notification`                 | System notification displayed in tray                  |
| 16  | Disable Accessibility Service          | 3 UI capabilities deregister from Core within 60s      |
| 17  | Verify client event stream             | `device.capabilities_changed` emitted                  |
| 18  | Re-enable Accessibility Service        | UI capabilities restored                               |
| 19  | Disconnect Wi-Fi and mobile data       | Worker enters `reconnecting` state                     |
| 20  | Restore network connectivity           | Reconnects and completes full authentication handshake |
| 21  | Revoke device in Core                  | Active session terminated                              |
| 22  | Dispatch task to revoked worker        | Rejected immediately                                   |
| 23  | Allow battery to drop below 20%        | Worker reports degraded status                         |
| 24  | Lock screen for 30 minutes             | Connection sustained without OS termination            |

---

## Transport Connection to Core

The worker depends on the `WorkerLink` port abstraction from `@nexus/worker-core`:

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

The interface exposes `connect()`, not `listen()`: the worker cannot accept inbound connections.

`AndroidWebSocketLink` (`src/connection/websocket-link.ts`) implements this over React Native's
standard `WebSocket` client backed by OkHttp. Handshake, registration, task dispatch, cancellation,
and event handling reside in `WorkerRuntime`, shared with the Windows worker.

Three specific safeguards:

| Safeguard                        | Rule                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Cleartext remote links banned    | Enforced — phones connect from untrusted networks. `localhost` and `10.0.2.2` are developer exceptions |
| Connection establishment timeout | 15s. Avoids hanging indefinitely behind captive portals                                                |
| Inbound frame limit              | 256 KB max, text frames only                                                                           |

### Certificate Pinning

The Windows worker pins the public key of the Core in `checkServerIdentity`. React Native's bridge
does not expose certificate hooks directly; pinning is configured via Android's native network security
configuration in `android/src/main/res/xml/network_security_config.xml`:

```xml
<domain-config>
    <domain includeSubdomains="true">nexus.example.com</domain>
    <pin-set expiration="2027-01-01">
        <pin digest="SHA-256">BASE64_PUBLIC_KEY_PIN</pin>
        <pin digest="SHA-256">BACKUP_PIN</pin>
    </pin-set>
</domain-config>
```

This is enforced by the operating system networking stack below OkHttp and React Native.

---

## Known Limitations

1. **Physical OEM testing outstanding.** Emulators do not replicate proprietary OEM background task
   killers or autostart managers.
2. **`WorkerActivity` and `ui/` are built via Metro**, outside default repository TypeScript typechecking.
   Core business logic in `src/` is 100% typechecked.
3. **Core certificate pinning is deployment-specific** and disabled in default development templates.
4. **Cancellation occurs at JavaScript boundary.** The React Native bridge does not propagate `AbortSignal`
   to native Accessibility threads.
5. **`android.app.open` may encounter OEM background start restrictions.** Descriptive error messages guide
   users on necessary permission toggles.
6. **Availability polling is periodic** (default 30s) as Android does not broadcast Accessibility service state changes.
7. **Android versions below 11 are unsupported for screenshots.**
8. **Shared code polyfills Node primitives.** `@nexus/shared` utilizes `node:crypto` and `Buffer`; `shim/`
   provides cryptographic primitives backed by `java.security.SecureRandom`.
9. **Legacy React Native architecture** (`newArchEnabled=false`). Future upgrades will migrate bridge calls
   to TurboModules.
