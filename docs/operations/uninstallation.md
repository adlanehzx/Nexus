# Uninstallation & Teardown Guide

This guide covers removing NEXUS and its associated services, workers, and containers from your host.

---

## 1. Stopping & Removing Docker Containers

To stop and remove all NEXUS Docker containers, networks, and persistent data volumes:

```bash
# Stop containers and remove volumes (DELETES postgres and redis persistent data)
pnpm docker:down -v
```

If you wish to retain your database volumes for a future reinstallation, omit `-v`:

```bash
pnpm docker:down
```

---

## 2. Removing Host Workers

### Linux / Docker Worker
```bash
docker rm -f nexus-worker
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/nexus-worker"
```

### Windows Worker Service
Open PowerShell as Administrator:
```powershell
# Stop and uninstall the NexusWorker Windows service
Stop-Service -Name "NexusWorker" -ErrorAction SilentlyContinue
sc.exe delete "NexusWorker"
Remove-Item -Recurse -Force "C:\Program Files\NEXUS\worker" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\nexus-worker" -ErrorAction SilentlyContinue
```

### Android Worker
Uninstall the NEXUS Worker application from Android Settings. The private key stored in Android Keystore will be destroyed automatically by the OS.

---

## 3. Removing Systemd User Services

If you configured background services using systemd user units:

```bash
systemctl --user stop nexus-mission-engine.service nexus-browser.service 2>/dev/null || true
systemctl --user disable nexus-mission-engine.service nexus-browser.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/nexus-mission-engine.service"
rm -f "$HOME/.config/systemd/user/nexus-browser.service"
systemctl --user daemon-reload
```

---

## 4. Removing Keys & Configuration

To completely remove generated secrets, configurations, and logs:

```bash
# Remove environment and database keys
rm -f .env

# Remove build artifacts and caches
pnpm clean
```

### Linux Keyring Vault Cleanup
If you stored secrets in the Linux Secret Service / Keyring:
```bash
# List and remove stored secrets
secret-tool clear service nexus
```

---

## 5. Deleting the Repository

```bash
cd ..
rm -rf nexus
```
