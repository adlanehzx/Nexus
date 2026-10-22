# Updating NEXUS

This guide explains how to safely update an existing NEXUS installation to the latest release while preserving data, persistent keys, and active configurations.

---

## 1. Pre-Update Backup

Before performing an update, take a backup of your configuration and database:

### Quick Dashboard Backup (No Terminal)
1. Open **Settings** in the NEXUS dashboard.
2. Scroll to the **Backup & Restore Assistant**.
3. Click **Export configuration backup** to download `nexus-configuration-backup-YYYY-MM-DD.json`.

### Full System Snapshot (CLI)
```bash
# Creates an archive containing database, secrets, and environment
pnpm nexus backup create --output nexus-pre-update.tar.gz
```

---

## 2. Updating Docker Platform

If you run NEXUS via Docker Compose:

```bash
# 1. Fetch latest changes
git pull origin main

# 2. Update dependencies and regenerate Prisma client
pnpm install
pnpm db:generate

# 3. Pull / rebuild updated platform images
pnpm docker:platform
```

The `migrate` ephemeral container runs automatically before the API restarts, safely applying any new database migrations.

---

## 3. Updating Host Development Mode

If you run NEXUS directly on the host:

```bash
# 1. Fetch latest changes
git pull origin main

# 2. Update dependencies
pnpm install

# 3. Rebuild packages
pnpm build

# 4. Apply database migrations
pnpm db:migrate

# 5. Restart dev processes
pnpm dev
```

---

## 4. Updating Workers

- **Linux / Docker Workers**: Re-pull the worker image and restart:
  ```bash
  docker pull ghcr.io/adlanehzx/nexus/worker:latest
  docker restart nexus-worker
  ```
- **Windows Worker**: Run the updated `setup-worker.ps1` installer or restart the `NexusWorker` service via Windows Services (`services.msc`).
- **Android Worker**: Update the APK and re-open the app; existing paired device keys in Android Keystore are preserved.

---

## 5. Post-Update Verification

Run the diagnostics suite to confirm all services are functional:

```bash
pnpm nexus doctor
curl http://localhost:3000/api/v1/health
```

---

## 6. Rollback Procedure

If an update encounters an issue:
1. Revert Git commits: `git checkout <PREVIOUS_COMMIT>`
2. Restore database and configuration:
   ```bash
   pnpm nexus backup restore --input nexus-pre-update.tar.gz
   ```
3. Restart containers: `pnpm docker:platform`
