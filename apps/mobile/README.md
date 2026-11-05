# NEXUS mobile client

The Expo and React Native client for iOS and Android provides conversations, agents and runs,
missions, usage and quotas, the MCP hub, models and providers, devices and satellites, remote
control, memory, voice input, reading replies aloud, notifications and settings.

Replies appear whole, because the core does not stream them yet. What the core lacks is specified in
[docs/BACKEND-GAPS.md](docs/BACKEND-GAPS.md); the app says so rather than simulating it.

It uses Expo SDK 57, React Native 0.86, Expo Router and the new architecture. Application decisions
live in the tested `@nexus/client-core` package; this directory contains platform wiring and UI.

## Development

```bash
cd apps/mobile
pnpm start:go
```

Put machine-specific Metro settings in an untracked `.env.local`. Configure the reachable Core URL
through `EXPO_PUBLIC_NEXUS_URL`; never use `localhost` when the phone must connect to another
machine. For a private Tailscale setup, enter a generic Metro URL such as
`exp://nexus-core.example-tailnet.ts.net:8081` in Expo Go and keep Tailscale connected on both
devices.

The Core URL is public application configuration, not a credential. Authentication tokens are
created at sign-in and stored in the platform keychain.

## Configure the core for mobile clients

Add the core's own public address to `CORS_ORIGINS` (for example `https://nexus.example.com`). React
Native always sends an `Origin` header built from the socket address, and the core refuses unlisted
origins with a 403, which leaves the app without realtime. See entry 13 of the backend gaps.

## Approve a new device

The client registers itself as a `CLIENT` device on first sign-in and remains untrusted. The
realtime channel intentionally refuses the device until an administrator approves it in
**Devices → Approve**. Approval uses the REST API, so it can be completed before the realtime
channel is available.

## Development builds

The repository contains the Expo development-client configuration, application icons and splash
screen. Native `ios/` and `android/` directories are generated rather than committed.

```bash
cd apps/mobile
pnpm exec eas-cli build --profile development --platform ios
pnpm start:dev-client
```

To build the Android debug APK locally, with JDK 17 and the Android SDK:

```bash
cd apps/mobile
pnpm exec expo prebuild --platform android --no-install
cd android && ./gradlew assembleDebug --max-workers=2
```

Without the worker limit, native compilation failed here with no compiler message; the cause was not
identified.

iOS deployment to physical devices requires Apple signing. Android development builds can produce
an installable APK without a paid account.

The project intentionally omits an Expo `owner`: declaring one makes Expo Go require access to that
specific account. An organization publishing official builds should set `owner` and its own
`extra.eas.projectId` in `app.json`.

## Tests

```bash
pnpm typecheck && pnpm lint && pnpm test
```

`test/live` runs against a real core and skips itself without `NEXUS_LIVE_URL`. Use a disposable
instance: it registers an account and devices. It also sends a chat message, so a core that can
reach a local CLI engine will use that account.

These tests run on Node, which hides differences from the app's engine: Hermes has no
`globalThis.crypto`, and React Native sends an `Origin` header. Check realtime on an emulator as well.
When driving one, start Metro without `CI=1`, which turns off reloading and serves a stale bundle.

## Monorepo integration

`metro.config.js` watches the monorepo root and resolves workspace symlinks such as
`@nexus/client-core` and `@nexus/protocol`. It also handles TypeScript sources imported with `.js`
extensions under `NodeNext` resolution while preserving normal JavaScript resolution.

See [client architecture](../../docs/architecture/12-clients.md) and the
[Tailscale guide](../../docs/network/TAILSCALE.md).
