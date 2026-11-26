# Updating NEXUS

This guide explains how to safely update an existing NEXUS installation to the latest release while preserving data, persistent keys, and active configurations.

---

## 1. Pre-Update Backup

Before performing an update, take a backup of your configuration and database:

### Quick Dashboard Backup (No Terminal)

1. Open **Settings** in the NEXUS dashboard.
2. Scroll to the **Backup & Restore Assistant**.
3. Click **Export configuration backup** to download `nexus-configuration-backup-YYYY-MM-DD.json`.

The dashboard export contains configuration only. It does not contain PostgreSQL, mission history, files, or vault credentials and is not a recovery backup.

### System backup (CLI)

```bash
# Creates a .nxbk archive in the configured backup directory.
# Secrets are excluded by default. Read the printed manifest and warnings.
pnpm nexus backup --keep 7

# Verify the archive using a disposable PostgreSQL restoration database.
pnpm nexus backup --verify /absolute/path/to/archive.nxbk
```

---

## 2. Updating Docker Platform

If you run NEXUS via Docker Compose:

```bash
# 1. Fetch latest changes
git pull --ff-only origin master

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
git pull --ff-only origin master

# 2. Update dependencies
pnpm install

# 3. Rebuild packages
pnpm build

# 4. Apply database migrations
pnpm --filter @nexus/database migrate:deploy

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

## Coverage and recovery limits

CLI backup includes PostgreSQL when configured, the Mission Engine SQLite snapshot when present, runtime configuration and the public verification key. It does not include arbitrary workspace files or credentials stored in the operating-system keyring. Copy workspaces separately. For a PostgreSQL-backed Mission Engine, set `NEXUS_ENGINE_DATABASE_URL` when creating the backup: its dump is included separately. Restore requires both destination database URLs before modifying either database and refuses identical destinations. Each PostgreSQL restore uses a single transaction; the two databases are not restored in one shared transaction.

`--include-secrets` includes `.env` and requires a non-empty encryption passphrase. Keep the passphrase separately from the archive. A backup without secrets requires recovery of the signing key and database credentials; keyring credentials must be entered again. Inspect the manifest before deleting the original installation. A successful archive creation is not proof of restoration: run the verification against a disposable database, then test the complete recovery procedure on an isolated installation before upgrading a production instance.

### Recovering encrypted configuration

When the archive includes `.env`, restore writes it to `.env.restore` with owner-only permissions. It never overwrites the destination `.env`. Merge the signing key and required settings while preserving the destination `DATABASE_URL`; remove the recovery file once finished. Restoration refuses to overwrite an existing `.env.restore`. The archive does not include operating-system keyring credentials, even with `--include-secrets`.

Stop API and mission-engine writers before restoring a live installation. The automated recovery test covers isolated API PostgreSQL plus either SQLite or a separate Mission Engine PostgreSQL database. It does not qualify restoring over active writers or an active SQLite WAL. Workspace grants and configurations outside the manifest must be recreated and reviewed on the destination machine.
