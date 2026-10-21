# ADR-007 — Device Agent in Headless Node.js, Separate from Desktop App

**Status**: Proposed · 2026-09-01

## Context

The user's PC must be able to execute tasks (filesystem, shell, Docker, Git) requested by the agent,
even when the desktop GUI application is closed. A daemon is therefore required. Two questions arise:
what runtime/language to choose, and should it be bundled inside the Tauri desktop shell?

## Decision

A **standalone Node.js daemon** (`apps/device-agent`), installed as a system service
(Windows Service / launchd / systemd), distinct from the desktop GUI application. The Tauri app
installs it, monitors it, displays its status and logs, and can run it as a local sidecar for
lightweight usage.

Distribution as a single signed binary (Node SEA or `pkg`), with signature-verified auto-updates.

## Alternatives

- **Write the agent in Rust inside the Tauri core.** Smaller memory footprint and faster startup.
  Rejected for two decisive reasons: we would have to **reimplement the WebSocket protocol and all
  Zod schemas in Rust**, causing the exact contract drift the monorepo is built to avoid; and the
  agent would cease running whenever the GUI window is closed, unless a second background service
  were written anyway.
- **No daemon: everything routes through the open desktop app.** Simple, but breaks the core use case
  ("run the test suite on my PC" initiated from mobile while the PC is on but the GUI app is closed).
- **Agent in Python.** No distinct benefit here, and introduces another runtime to package and
  distribute to client machines.

## Consequences

**Positive** — `@nexus/device-protocol` and `@nexus/contracts` are shared directly: a single, typed,
once-tested protocol. The agent operates without a display server. It can be deployed onto headless
machines (home servers, NAS units).

**Negative, accepted** — An embedded Node runtime weighs ~50 MB and consumes ~40 MB RSS idle
(acceptable on modern workstations); service installation logic must be maintained across three OS
families, alongside code signing certificates on Windows and macOS.
