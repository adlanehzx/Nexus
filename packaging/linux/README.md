# Linux, NAS, and Raspberry Pi Worker

The worker is distributed as a multi-arch container image (`amd64` and `arm64`).
It exposes no ports: its WebSocket connection to NEXUS is strictly outbound.

From **NEXUS → Devices**, generate a pairing token, then run on the Linux machine:

```sh
printf '%s' "ONE_TIME_TOKEN" | ./install-worker.sh https://nexus.example.com /srv/nexus-workspace
```

The container runs read-only, with all Linux capabilities dropped, and can only access the directory explicitly mounted into `/workspace`. The host's Docker socket is not mounted. To remove the machine, revoke it first from the NEXUS UI, then run `docker rm -f nexus-worker`; keys remain in `~/.local/share/nexus-worker` until intentionally deleted.
