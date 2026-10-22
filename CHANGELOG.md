# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-22

### Added
- **Interactive Setup Wizard**: `nexus setup` with automated prerequisite checks, idempotent Ed25519 auth signing key and AES-256 master key generation (stored in `.env` with mode `0600` without stdout leakage), Docker vs dev mode selection, and automatic Tailscale detection.
- **Enhanced Diagnostics (`nexus doctor`)**: System validation including master encryption key checks, loopback warning on `PUBLIC_API_URL`, Tailscale status probing, and actionable remedy instructions.
- **Terminal-Free Supervision Dashboard**:
  - System readiness and installation onboarding status card on the Overview screen.
  - "Connect an Agent" ecosystem view with "Detect installed agents" button, distinct cards for Codex, Claude Code, and Antigravity, and isolated display of Host CLI, ACP Adapter, and Session state.
  - Multi-profile routing visualization displaying associated identities, priority tiers, and cooldown states.
  - Interactive SVG QR Code generator in Devices view for scanning pairing deep links (`nexus://pair?api=...&token=...`) directly with the Android Worker or iOS app.
  - In-browser Backup & Restore assistant supporting JSON configuration export, validation, and restoration without terminal commands.
  - Host connector Docker isolation guide with step-by-step connection instructions.
- **Mobile & Voice Subsystem**:
  - Real functional speech recognition abstraction (`LocalSpeechToText`) supporting streaming partial transcription, clean cancellation, explicit dependency status, and zero raw audio persistence on disk.
  - Neural text-to-speech abstraction (`PiperTextToSpeech`) with seamless fallback to `ExpoTextToSpeech`.
- **Packaging & Supply Chain Security**:
  - SPDX 2.3 Software Bill of Materials (SBOM) generator (`scripts/generate-sbom.mjs`) tracking all 34 internal packages and dependencies.
  - Multi-hash checksum generator (`scripts/generate-checksums.mjs`) producing `SHA256SUMS` and `SHA512SUMS`.
  - Comprehensive Beginner's Installation Guide (`docs/operations/installation-guide.md`), Updating Guide (`docs/operations/updating.md`), and Uninstallation Guide (`docs/operations/uninstallation.md`).
  - Clear documentation of unsigned artifact markers for community builds lacking vendor signing keys.
  - Strict AGPL-3.0-or-later license demarcation across packages and packaging scripts.

### Changed
- Rebuilt Android Worker JS bundle (`services/android-worker/android/app/src/main/assets/index.android.bundle`) eliminating obsolete French strings and hardcoded local IP addresses.
- Updated connector documentation note in `services/connector/README.md` reflecting Fastify core API `/api/v1/connections` and Dashboard integration.
- Translated packaging PowerShell scripts (`packaging/windows/setup-worker.ps1`) to English.
- Updated Arch Linux package configuration (`packaging/arch/PKGBUILD`) to `AGPL-3.0-or-later`.

### Fixed
- Fixed hardcoded French URL fallback `"https://votre-nexus"` in dashboard device pairing payload, dynamically resolving to `window.location.origin`.
- Fixed connection state conflation, guaranteeing that `connected` is strictly reserved for live verified sessions and never faked for detected CLIs.
