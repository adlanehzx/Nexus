# Publishing a Release

This document defines the release procedure, supply chain verification, and artifact integrity guarantees for NEXUS.

---

## 1. Pre-Release Quality Gates

Before creating a release tag, the release branch must pass all automated verification gates:

```bash
# 1. Format and linting verification
pnpm format:check
pnpm lint

# 2. Complete typechecks and unit test suites across all 34 packages
pnpm typecheck
pnpm test

# 3. Release hygiene (no committed .env, zero personal paths, no private tailnet hostnames)
pnpm release:check

# 4. English-only string audit
pnpm translation:check

# 5. Infrastructure rendering validation
docker compose -f infrastructure/docker/docker-compose.yml config >/dev/null
pnpm k8s:render >/dev/null
```

---

## 2. Supply Chain Security & Artifact Integrity

Every official release includes cryptographic checksums and a full Software Bill of Materials:

### Generating SPDX 2.3 SBOM

Run the automated SBOM generator to inventory all internal packages and external dependencies:

```bash
node scripts/generate-sbom.mjs
# Produces release/sbom.spdx.json
```

### Generating Multi-Hash Checksums

Compute SHA-256 and SHA-512 hashes for all generated release bundles:

```bash
node scripts/generate-checksums.mjs
# Produces release/SHA256SUMS and release/SHA512SUMS
```

Verify checksums locally:

```bash
cd release && sha256sum -c SHA256SUMS
```

---

## 3. Signing Policy: Signed vs Unsigned Artifacts

### Signed Container Images

Docker images (`ghcr.io/adlanehzx/nexus/api`, `ghcr.io/adlanehzx/nexus/dashboard`, etc.) are built by the GitHub Actions release workflow and signed keylessly using Cosign with GitHub OIDC identity:

```bash
cosign verify ghcr.io/adlanehzx/nexus/api:v1.0.0 \
  --certificate-identity-regexp='https://github.com/adlanehzx/Nexus/.github/workflows/release.yml' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

### Explicitly Unsigned Community Artifacts

In open-source builds where official EV hardware code signing certificates or Apple developer keys are not configured:

- **Windows NSIS Installer** (`nexus-worker-setup.exe`): Marked **unsigned** (will trigger standard Windows SmartScreen on first run).
- **Android Worker APK** (`nexus-worker-release-unsigned.apk`): Built using debug keystore or unsigned (requires "Install from unknown sources" or adb install).
- **Arch Linux PKGBUILD**: Built from source directly on the target host.

> **Rule:** Never pretend an artifact is cryptographically signed without a verified signature and certificate chain. Release notes must explicitly state when an asset is unsigned.

---

## 4. AGPL-3.0 License Demarcation

NEXUS is published under the **GNU Affero General Public License v3.0 or later** (`AGPL-3.0-or-later`).

- Core services (`services/api`, `services/mission-engine`, `services/connector`, etc.) enforce network copyleft.
- Packaging scripts, PKGBUILDs, and installers must retain `AGPL-3.0-or-later` headers.
- If providing client SDKs or integrations, keep boundaries clearly isolated.

---

## 5. Release Checklist

1. Update version in `package.json` and all package manifests.
2. Update `CHANGELOG.md` with release notes and date.
3. Run the complete pre-release quality gate (`pnpm release:check`, `pnpm translation:check`, `pnpm test`).
4. Generate SBOM: `node scripts/generate-sbom.mjs`.
5. Create an annotated Git tag:
   ```bash
   git tag -s -a v1.0.0 -m "Release v1.0.0"
   ```
6. Verify checksums and upload release artifacts alongside `SHA256SUMS` and `sbom.spdx.json`.
