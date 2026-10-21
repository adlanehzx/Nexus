# NEXUS mobile client

The Expo and React Native client provides conversations, streaming responses, tool and confirmation
cards, microphone input, history, permissions, memory and device management.

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

iOS deployment to physical devices requires Apple signing. Android development builds can produce
an installable APK without a paid account.

The project intentionally omits an Expo `owner`: declaring one makes Expo Go require access to that
specific account. An organization publishing official builds should set `owner` and its own
`extra.eas.projectId` in `app.json`.

## Monorepo integration

`metro.config.js` watches the monorepo root and resolves workspace symlinks such as
`@nexus/client-core` and `@nexus/protocol`. It also handles TypeScript sources imported with `.js`
extensions under `NodeNext` resolution while preserving normal JavaScript resolution.

See [client architecture](../../docs/architecture/12-clients.md) and the
[Tailscale guide](../../docs/network/TAILSCALE.md).
