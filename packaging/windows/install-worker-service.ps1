<#
.SYNOPSIS
    Installs the NEXUS worker as a Windows service.

.DESCRIPTION
    The worker must run **without an active user session**: an assistant that only
    executes tasks when someone is logged in is useless in the morning when asked
    from a phone to have prepared work in advance.

    Three decisions and their rationale:

    1. **Service account, not SYSTEM.** `LocalSystem` grants full machine access
       to the worker, defeating local device policy: path restrictions protect
       nothing if the process has unlimited system privileges. The service
       therefore runs under a dedicated virtual account or user account.

    2. **Automatic but bounded restart.** A crashing worker that restarts in a
       tight loop creates a denial of service on the host. Restart backoff grows,
       and after three consecutive failures Windows waits 60 seconds.

    3. **No secrets in command line arguments.** Private keys are referenced by
       FILE PATH. Service command lines are readable by any unprivileged user
       via Task Manager or WMI.

    This script relies on native `sc.exe`, present on every Windows installation,
    avoiding third-party service wrappers.

.PARAMETER InstallDir
    Worker installation directory (containing `dist/main.js`).

.PARAMETER NodeExe
    Path to node.exe. Defaults to node found in PATH.

.PARAMETER ServiceAccount
    Account under which the service runs. Defaults to `NT SERVICE\nexus-worker`,
    a virtual service account requiring no password management.

.EXAMPLE
    .\install-worker-service.ps1 -InstallDir C:\ProgramData\NEXUS\worker
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [string]$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source,
    [string]$ServiceName = 'nexus-worker',
    [string]$ServiceAccount = 'NT SERVICE\nexus-worker',
    [string]$EnvFile = (Join-Path $env:ProgramData 'NEXUS\worker.env')
)

$ErrorActionPreference = 'Stop'

if (-not $NodeExe) {
    throw "node.exe not found. Install Node 24 or pass -NodeExe."
}
$entry = Join-Path $InstallDir 'dist\main.js'
if (-not (Test-Path $entry)) {
    throw "Entry point missing: $entry. Run 'pnpm build' first."
}
if (-not (Test-Path $EnvFile)) {
    throw "Configuration missing: $EnvFile. Run setup-worker.ps1 first."
}

# File permissions on .env matter as much as its content: it points to the private key path.
$acl = Get-Acl $EnvFile
$inherited = $acl.Access | Where-Object { $_.IsInherited -eq $true }
if ($inherited) {
    Write-Warning "$EnvFile inherits permissions from parent directory. Restrict with: icacls `"$EnvFile`" /inheritance:r /grant:r `"$env:USERNAME:(R)`""
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "Existing service detected: stopping and deleting before reinstall."
    sc.exe stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

# `binPath` quotes node AND entry script: unquoted paths with spaces break service execution.
$binPath = "`"$NodeExe`" --env-file=`"$EnvFile`" `"$entry`""

$createArgs = @(
    'create', $ServiceName,
    "binPath= $binPath",
    'start= delayed-auto',
    'DisplayName= NEXUS — Local Worker'
)
if ($ServiceAccount) {
    $createArgs += "obj= $ServiceAccount"
}
sc.exe @createArgs
if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed ($LASTEXITCODE)." }

# The virtual account only exists after `sc create`. Grant only read permissions.
$credentialLine = Get-Content $EnvFile | Where-Object { $_ -match '^DEVICE_CREDENTIAL_PATH=' } | Select-Object -First 1
if (-not $credentialLine) { throw 'DEVICE_CREDENTIAL_PATH missing from configuration.' }
$credentialPath = $credentialLine.Substring('DEVICE_CREDENTIAL_PATH='.Length)
icacls $EnvFile /inheritance:r /grant:r "${ServiceAccount}:(R)" 'Administrators:(F)' | Out-Null
icacls $credentialPath /inheritance:r /grant:r "${ServiceAccount}:(R)" 'Administrators:(F)' | Out-Null

sc.exe description $ServiceName 'Executes NEXUS tasks assigned to this machine. Enforces local policy ~/.nexus/device-policy.yaml.' | Out-Null

# Bounded restarts: 5s, 30s, 60s, reset failure counter after 24 hours.
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

Write-Host ""
Write-Host "Service '$ServiceName' installed successfully."
Write-Host "  Start      : sc.exe start $ServiceName"
Write-Host "  Logs       : Event Viewer -> Windows Logs -> Application"
Write-Host "  Uninstall  : sc.exe stop $ServiceName ; sc.exe delete $ServiceName"
Write-Host ""
Write-Host "The service is configured as 'delayed-auto' to start after core system services."
