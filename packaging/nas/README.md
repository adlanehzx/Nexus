# NEXUS NAS One-Click Deployment

Deploy NEXUS server and companion stack directly on Network Attached Storage (NAS) appliances.

## 1. Explicitly Supported Platforms

| NAS Platform                | OS / Interface               | Deployment Method                                           | Default Mount Path       |
| :-------------------------- | :--------------------------- | :---------------------------------------------------------- | :----------------------- |
| **Synology DSM 7+**         | Container Manager            | Compose Project (`synology-docker-compose.yml`)             | `/volume1/docker/nexus`  |
| **QNAP QTS 5+ / QuTS hero** | Container Station            | Application JSON (`qnap-container-station.json`) or Compose | `/share/Container/nexus` |
| **TrueNAS SCALE (23+)**     | Apps / Custom Docker Compose | Compose (`truenas-docker-compose.yml`)                      | `/mnt/tank/apps/nexus`   |

## 2. Security and Isolation Principles

- **Non-Root Execution**:
  Containers run under standard platform unprivileged users (`1026:100` on Synology, `568:568` on TrueNAS).
- **Persistent Storage Isolation**:
  Databases and file uploads live in dedicated persistent volume directories with `0750` permissions.
- **Random Secrets Generation**:
  Database passwords and master JWT secrets are automatically generated via `openssl rand -hex` and stored in `0600` `.env` files. Never committed to source control.
- **Health-Checked Containers**:
  Every service includes health checks ensuring Postgres and Redis are fully operational before API initialization.

## 3. One-Click Setup Guide

### Method A: Automated CLI Deployment

SSH into your NAS and run:

```bash
bash install-nas.sh
cd /volume1/docker/nexus # (or auto-detected path)
docker compose --env-file .env up -d
```

### Method B: Synology Container Manager UI

1. Open **Container Manager** > **Project** > **Create**.
2. Set Project Name: `nexus`.
3. Set Path: `/docker/nexus`.
4. Source: Upload `synology-docker-compose.yml`.
5. Enter your database password and JWT secret in the Environment settings.
6. Click **Done** to launch.

### Method C: TrueNAS SCALE UI

1. Open **Apps** > **Discover Apps** > **Custom App (Docker Compose)**.
2. Paste the contents of `truenas-docker-compose.yml`.
3. Configure your dataset paths under `/mnt/tank/apps/nexus`.
4. Save and deploy.

## 4. Teardown and Uninstallation

To cleanly stop and remove containers while preserving persistent datasets:

```bash
bash install-nas.sh --uninstall
```

To permanently delete all data, delete the target storage directory manually.
