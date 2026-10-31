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

    Node.js is not itself a Windows service executable. The script therefore
    uses a pinned WinSW release as the minimal Service Control Manager bridge,
    and verifies its SHA-256 digest before installing it.

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
    [string]$EnvFile = (Join-Path $env:ProgramData 'NEXUS\worker.env'),
    [string]$WinSWPath,
    [string]$WinSWDownloadUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
    [string]$WinSWSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
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
    Write-Warning "$EnvFile inherits permissions from parent directory. Restrict with: icacls `"$EnvFile`" /inheritance:r /grant:r `"${env:USERNAME}:(R)`""
}

$configDir = Split-Path $EnvFile -Parent
$serviceDir = Join-Path $configDir 'service'
$logDir = Join-Path $configDir 'logs'
$wrapperPath = Join-Path $serviceDir "$ServiceName.exe"
$wrapperConfigPath = Join-Path $serviceDir "$ServiceName.xml"
New-Item -ItemType Directory -Force -Path $serviceDir, $logDir | Out-Null

$downloadedWrapper = $false
if ($WinSWPath) {
    if (-not (Test-Path $WinSWPath -PathType Leaf)) { throw "WinSW binary not found: $WinSWPath" }
    Copy-Item -Force $WinSWPath $wrapperPath
} elseif (-not (Test-Path $wrapperPath -PathType Leaf)) {
    $temporaryWrapper = Join-Path ([IO.Path]::GetTempPath()) "nexus-winsw-$([guid]::NewGuid()).exe"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $WinSWDownloadUrl -OutFile $temporaryWrapper
        Move-Item -Force $temporaryWrapper $wrapperPath
        $downloadedWrapper = $true
    } finally {
        Remove-Item -Force $temporaryWrapper -ErrorAction SilentlyContinue
    }
}
$actualHash = (Get-FileHash $wrapperPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $WinSWSha256.ToLowerInvariant()) {
    if ($downloadedWrapper) { Remove-Item -Force $wrapperPath -ErrorAction SilentlyContinue }
    throw 'WinSW checksum verification failed.'
}

# WinSW must sit next to an XML file with the same base name. Arguments contain
# paths only; credentials remain in the ACL-protected environment file.
$escapedNode = [Security.SecurityElement]::Escape($NodeExe)
$escapedEntry = [Security.SecurityElement]::Escape($entry)
$escapedEnv = [Security.SecurityElement]::Escape($EnvFile)
$escapedInstallDir = [Security.SecurityElement]::Escape($InstallDir)
$escapedLogDir = [Security.SecurityElement]::Escape($logDir)
$wrapperConfig = @"
<service>
  <id>$ServiceName</id>
  <name>NEXUS - Local Worker</name>
  <description>Executes NEXUS tasks assigned to this machine under local policy.</description>
  <executable>$escapedNode</executable>
  <arguments>--env-file=&quot;$escapedEnv&quot; &quot;$escapedEntry&quot;</arguments>
  <workingdirectory>$escapedInstallDir</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>20 sec</stoptimeout>
  <logpath>$escapedLogDir</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <hidewindow>true</hidewindow>
</service>
"@
[IO.File]::WriteAllText($wrapperConfigPath, $wrapperConfig, [Text.UTF8Encoding]::new($false))

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "Existing service detected: stopping and deleting before reinstall."
    sc.exe stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

$createArgs = @(
    'create', $ServiceName,
    'binPath=', $wrapperPath,
    'start=', 'auto',
    'DisplayName=', 'NEXUS - Local Worker'
)
if ($ServiceAccount) {
    $createArgs += @('obj=', $ServiceAccount)
}
sc.exe @createArgs
if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed ($LASTEXITCODE)." }
sc.exe config $ServiceName start= delayed-auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe delayed-auto configuration failed ($LASTEXITCODE)." }

# The virtual account only exists after `sc create`. Grant only read permissions.
$credentialLine = Get-Content $EnvFile | Where-Object { $_ -match '^DEVICE_CREDENTIAL_PATH=' } | Select-Object -First 1
if (-not $credentialLine) { throw 'DEVICE_CREDENTIAL_PATH missing from configuration.' }
$credentialPath = $credentialLine.Substring('DEVICE_CREDENTIAL_PATH='.Length)
# Use the built-in Administrators SID instead of its localized display name.
$administrators = '*S-1-5-32-544'
icacls $EnvFile /inheritance:r /grant:r "${ServiceAccount}:(R)" "${administrators}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict the worker environment ACL ($LASTEXITCODE)." }
icacls $credentialPath /inheritance:r /grant:r "${ServiceAccount}:(R)" "${administrators}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to restrict the device credential ACL ($LASTEXITCODE)." }
icacls $serviceDir /grant:r "${ServiceAccount}:(OI)(CI)(RX)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant service wrapper access ($LASTEXITCODE)." }
icacls $logDir /grant:r "${ServiceAccount}:(OI)(CI)(M)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant service log access ($LASTEXITCODE)." }

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
