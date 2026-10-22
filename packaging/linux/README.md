# Linux, NAS, and Raspberry Pi Worker

The worker is distributed as a multi-arch container image (`amd64` and `arm64`).
It exposes no ports: its WebSocket connection to NEXUS is strictly outbound.

## Prerequisites

- **Docker Engine** 27+ with Compose v2
- Standard Linux, NAS (Synology/QNAP with Container Manager), or Raspberry Pi (Raspberry Pi OS 64-bit)
- Outbound network access to reach your NEXUS central instance (or via Tailscale)

## Installation and Pairing

From **NEXUS → Devices**, generate a pairing token, then run on the Linux machine:

```sh
printf '%s' "ONE_TIME_TOKEN" | ./install-worker.sh https://nexus.example.com /srv/nexus-workspace
```

The container runs read-only, with all Linux capabilities dropped (`--cap-drop ALL`), `no-new-privileges` enabled, under the host user's UID/GID, and can only access the directory explicitly mounted into `/workspace`. The host's Docker socket is never mounted.

## Uninstallation

To remove the worker:

1. Revoke the device first from the NEXUS UI (**Supervision → Devices**).
2. Stop and remove the Docker container:
   ```sh
   docker rm -f nexus-worker
   ```
3. (Optional) Remove pairing credentials and local configuration:
   ```sh
   rm -rf ~/.local/share/nexus-worker
   ```
