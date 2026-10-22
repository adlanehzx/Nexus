# Windows Worker Package and Service

This directory provides automated packaging and service installation for the NEXUS Windows background worker.

## Architecture and Security

1. **Virtual Service Account (`NT SERVICE\nexus-worker`)**: The worker runs under a dedicated virtual account, never as `LocalSystem`. It is restricted to declared allowed folders (e.g. `Documents\NEXUS`) and local device policy.
2. **Zero Command-Line Secrets**: Pairing tokens are piped through standard input (`-TokenStdin`), preventing token leakage in process lists or event logs.
3. **Bounded Automatic Restarts**: In case of failures, service recovery backoff increases (5s, 30s, 60s) preventing tight crash loops.

## Prerequisites

- **Windows 10 / 11 / Windows Server 2019+** (x64)
- **Node.js** 24.20.0+ on PATH
- **PowerShell** 5.1 or PowerShell 7+
- **Administrator rights** (required to register Windows Services and configure file ACLs)

## Installation and Pairing

1. In NEXUS Dashboard, navigate to **Supervision → Devices** and click **Generate code** to produce a pairing ticket.
2. Run PowerShell as Administrator and pipe the pairing token:

```powershell
powershell -Command "'<PAIRING_TOKEN>' | & 'C:\Program Files\NEXUS\worker\setup-worker.ps1' -NexusUrl 'https://your-nexus-server' -TokenStdin"
```

3. In NEXUS Dashboard, click **Approve** on the newly detected device.

## Uninstallation

To cleanly stop and remove the NEXUS worker service:

```powershell
# 1. Stop and remove the Windows service
sc.exe stop nexus-worker
sc.exe delete nexus-worker

# 2. Remove worker application files
Remove-Item -Recurse -Force "$env:ProgramFiles\NEXUS\worker"

# 3. (Optional) Remove pairing credentials and local configuration
# Only do this if you intend to permanently decommission this worker:
Remove-Item -Recurse -Force "$env:ProgramData\NEXUS"
```
