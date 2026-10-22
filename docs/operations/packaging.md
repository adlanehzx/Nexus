# Packaging, Signing, and Publishing

## What is Automated, and What Cannot Be

| Artifact         | Produced By                              | Signed By                                   |
| ---------------- | ---------------------------------------- | ------------------------------------------- |
| AppImage, `.deb` | "Packages" workflow, Linux runner        | Tauri key (`TAURI_SIGNING_PRIVATE_KEY`)     |
| Arch package     | `packaging/arch/PKGBUILD`, built on host | None — Arch builds directly from source     |
| MSI, NSIS        | Windows runner                           | Code signing certificate                    |
| `.dmg`           | macOS runner                             | Apple certificate, followed by notarization |
| APK              | Linux runner + Gradle                    | Android keystore                            |
| TestFlight       | **Manual**, see below                    | Apple certificate                           |

**No secrets are required to run the build pipeline.** In the absence of certificates or keystores,
packages are built **unsigned**: functional for local testing, but flagged by SmartScreen and
Android package installers. This is intentional — a pipeline that only runs when secrets are configured
cannot be properly tested in forks or CI, and breaking changes are only noticed on release day. Each
workflow run clearly reports in its job summary whether each artifact was signed or left unsigned.

## The Flaw That Previously Blocked Non-Windows Builds

`apps/desktop/src-tauri/Cargo.toml` previously declared `keyring` with `features = ["windows-native"]`
in the **common** dependencies block. As a result, the desktop shell could not compile on platforms
other than Windows, preventing AppImage, `.deb`, and `.dmg` generation without any explicit warning
since Linux compilation was not routinely validated.

The dependency is now properly segregated per platform: the requirement is identical everywhere —
authentication tokens do not belong in plaintext configuration files or renderer webview storage —
only the underlying OS credential provider differs (Credential Manager, Keychain, Secret Service).

The `desktop-compile` job compiles the shell under Linux **on every push** to ensure this class of
regression cannot go unnoticed. It executes `cargo check` rather than `tauri build`: validating cross-platform
compilation capability, leaving artifact packaging to the dedicated release workflow.

### `Cargo.lock` Regeneration

Declaring `keyring` per platform modifies the Cargo dependency graph, requiring lockfile regeneration —
which demands a full Rust toolchain.

The workflow job acted as its own toolchain: it detected dependency drift, exported the computed lockfile
as a build artifact, which was subsequently committed. Four platform-specific crates were added:
`dbus-secret-service` (Linux), `security-framework` and `security-framework-sys` (macOS), and `zeroize_derive`.
`windows-sys` was already included. All platform credential targets are now recorded in the lockfile.

`--locked` is enforced, ensuring reproducible builds. The drift detection check remains active: it should
not trigger normally, which is why it remains in place to guide developers if dependencies change.

## Binary Code Signing

### What Signing Guarantees, and What It Does Not

Signing verifies that a binary originates from the holder of the signing key and has not been altered
in transit. It does not certify the program's runtime safety. A signed binary can still contain bugs
or vulnerabilities; an unsigned binary may be entirely safe. Signing makes unauthorized substitution
**detectable**; it does not validate application behavior.

### Secrets and Storage

Never committed to Git. Never placed in repository tracking. Secrets live exclusively in repository
secret storage and are provided to workflow jobs as environment variables:

```
TAURI_SIGNING_PRIVATE_KEY           Tauri update signing private key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
APPLE_CERTIFICATE                   Base64-encoded .p12
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   Apple notarization credentials
ANDROID_KEYSTORE_BASE64             Base64-encoded .jks keystore
ANDROID_KEYSTORE_PASSWORD
ANDROID_KEY_ALIAS
ANDROID_KEY_PASSWORD
```

The Android keystore is decoded into the runner's temporary directory, never within the working tree,
preventing accidental commits via `git add -A`.

### Generating the Tauri Update Key

```sh
pnpm --filter @nexus/desktop exec tauri signer generate -w ~/.nexus/tauri-update.key
```

The **public key** is committed in `tauri.conf.json` (`plugins.updater.pubkey`), while the private
key is stored in deployment secrets. Without a public key, the updater remains `active: false`: an
updater without cryptographic verification would accept arbitrary unsigned bundles, creating an
unacceptable attack vector.

### Android: Why Unsigned APKs are Built Rather Than Failing

Failing when a keystore is absent prevents validating the Android toolchain: developers cannot
determine whether a failure stems from application code or missing credentials. Producing an
unsigned APK verifies the complete compilation and bundling process, yielding an artifact that
requires explicit debug installation flags — exactly what is needed for local development.

`enableV1Signing` remains active: Android devices running Android 10 or older cannot install APKs
signed solely with V2 schemas.

## Windows Worker Installer

The MSI bundle built by Tauri installs the **desktop GUI shell**. The worker is fundamentally different:
a headless Node daemon that must run without an active interactive user desktop session. Hence,
`packaging/windows/nexus-worker.nsi` provides an independent installer built by the Windows release runner.

NSIS was chosen over MSI: building MSIs requires WiX and an additional toolchain without tangible
benefit here — there is neither Active Directory Group Policy deployment nor remote uninstallation orchestration.

Four specific design decisions are enforced:

**Per-Machine Installation.** A Windows service is a machine-wide resource; installing it within a
specific user profile creates a service whose underlying binaries vanish if that user profile is removed.

**Configuration Lives Outside `Program Files`.** The `Program Files` directory is read-only for standard
users, and a background service unable to read or write runtime settings fails silently. Configuration
resides in `%APPDATA%\NEXUS\worker.env`, and reinstallations never overwrite existing configurations.

**Node.js is Not Bundled.** Bundling a Node runtime freezes an engine version that would require manual
updates on every upstream security advisory — and because this worker executes shell commands on the host,
it requires an up-to-date runtime. The installer checks for Node on the system path and halts cleanly
with instructions if absent.

**The Service is Not Started Automatically.** Users must first configure their device ID, central API
endpoint URL, and private key path. A service started prior to configuration enters a crash loop, fills
the Windows Event Log, and gives the false impression that installation failed. The installer displays
the required setup commands upon completion.

Uninstallation halts and deregisters the service **before** removing binary files — reversing the order
leaves an orphaned service perpetually attempting to launch missing binaries — and preserves configuration
files so version updates do not require re-pairing the device.

## Windows Service Configuration

`packaging/windows/install-worker-service.ps1`, orchestrated via native `sc.exe` — available on all
Windows editions without third-party wrapper dependencies.

| Decision                                     | Reason                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dedicated service account, not `LocalSystem` | `LocalSystem` grants unrestricted machine privileges, invalidating local path policies: filesystem restrictions provide no protection if the process is root |
| Bounded automatic restarts (5s, 30s, 60s)    | A continuously crashing worker restarting immediately transforms an isolated defect into an aggressive CPU/log denial of service                             |
| No secrets passed in command-line arguments  | Service command lines are visible to any unprivileged user via Task Manager; private keys are referenced strictly by filesystem path                         |
| `delayed-auto` startup mode                  | Boots following essential system services to avoid lengthening host boot times                                                                               |

The script halts if `.env` configuration is missing, and warns if permissions on the file are insecurely
inherited from the parent folder.

## iOS and TestFlight

### Scope and Prerequisites

iOS artifacts cannot be built or validated without macOS hardware and an active Apple Developer
account. This document details the procedure for operators.

### One-Time Setup

1. **Apple Developer Account** and an App ID — such as `app.nexus.mobile` — created in App Store Connect.
2. **Provisioning Profile** of type _App Store_, bound to the distribution certificate.
3. **Capabilities**: NEXUS mobile requests microphone access (voice dictation) and push notifications.
   Every capability requested must be justified in App Store Connect submission metadata.
4. **Privacy Declaration**: The app communicates with _your_ private server. The privacy disclosure
   must clearly state that data does not leave user-controlled infrastructure, and that dictation
   audio is processed without retention — verified by `@nexus/voice` test suites.

### Building a Release

```sh
cd apps/mobile
pnpm expo prebuild --platform ios
cd ios && pod install
xcodebuild -workspace NEXUS.xcworkspace -scheme NEXUS \
  -configuration Release -archivePath build/NEXUS.xcarchive archive
xcodebuild -exportArchive -archivePath build/NEXUS.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/ipa
xcrun altool --upload-app -f build/ipa/NEXUS.ipa \
  -u "$APPLE_ID" -p "$APPLE_APP_PASSWORD"
```

### Initial Submission Notes

- **Microphone Purpose String**: Generic descriptions will trigger rejection. Use descriptive text:
  "Dictate commands and messages to your personal assistant; audio is processed directly and never stored."
- **Self-Hosted Backend Review**: Apps requiring a private backend require clear demo reviewer credentials.
  Always provide a disposable, isolated demo backend instance.
- **No Side-Loaded Auto-Updates on iOS**: `UpdatePolicy` acts purely informatively on iOS; updates
  are distributed strictly through the App Store or TestFlight.

## Automatic Updates

Update decisions are evaluated by `UpdatePolicy` in `@nexus/client-core`. It neither downloads nor
executes binaries directly — the host platform verifies cryptographic signatures and applies updates.
Safety rules documented in `docs/architecture/12-clients.md`: no unsigned packages, no downgrades,
no channel hopping, no major version upgrades without explicit user confirmation.
