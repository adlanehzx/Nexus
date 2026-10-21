# ADR-008 — Desktop in Tauri v2

**Status**: Proposed · 2026-09-01

## Context

The system requirements mention Tauri "if relevant, otherwise provide a justified alternative".
The desktop application serves two distinct purposes: a conversation chat client, and a supervisory
shell for the Device Agent (status, live logs, local policy editor, pause toggle).

## Decision

**Tauri v2**, with a React UI shared with the web dashboard, augmented with native OS integrations
(system tray, global hotkeys, spotlight quick-input window, native notifications, launch on boot,
deep links). The Device Agent remains an independent background process (ADR-007) supervised by
the application.

## Alternatives

- **Electron.** Strong argument in its favor: identical webview (Chromium) across all operating
  systems ensuring zero rendering inconsistencies, plus mature ecosystem (auto-update, packaging,
  crash reporting). Rejected: ~120 MB binary vs. ~10 MB, 150–250 MB idle RSS vs. ~60 MB, and an
  insecure-by-default execution model whereas Tauri enforces explicit capability declarations —
  aligning with our broader defense-in-depth architecture.
- **Progressive Web App (PWA).** Zero packaging friction, but lacks system tray support, global
  hotkeys, and local daemon supervision. Insufficient for a host controller shell.
- **Native (WinUI/SwiftUI).** Best platform integration, but requires writing and maintaining two
  separate user interfaces for marginal benefit on this product.

## Consequences

**Positive** — Lightweight binary, rapid startup, minimal memory footprint for an always-running
utility; fine-grained permissions; built-in signed auto-updates; Rust available when low-level
system primitives are required.

**Negative, accepted** — The **webview runtime depends on host OS** (WebView2 on Windows, WKWebView
on macOS, WebKitGTK on Linux): slight CSS rendering differences. Mitigation: clean, sober design
system without exotic CSS effects, with Windows prioritized as the primary development target.
Requires Rust toolchain in CI runners.

## Reversibility

Risk is contained: the UI is standard React consuming `@nexus/sdk-client`. Migrating to Electron
would involve replacing the native wrapper shell without rewriting the application frontend.
