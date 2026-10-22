<# Pairs, configures and installs the NEXUS worker in a single command. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NexusUrl,
    [Parameter(Mandatory = $false)][string]$PairingToken,
    [switch]$TokenStdin,
    [string]$Name = $env:COMPUTERNAME,
    [string[]]$AllowedPaths = @((Join-Path $env:USERPROFILE 'Documents\NEXUS')),
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'NEXUS\worker'),
    [string]$ConfigDir = (Join-Path $env:ProgramData 'NEXUS'),
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node 24 or newer is required.' }

$pairEntry = Join-Path $InstallDir 'dist\pair.js'
if (-not (Test-Path $pairEntry)) { throw "Incomplete installer: $pairEntry not found." }

if ($TokenStdin) {
    $PairingToken = ($input | Out-String).Trim()
} elseif (-not $PairingToken) {
    if ([Environment]::UserInteractive) {
        $secure = Read-Host -Prompt 'Enter pairing token' -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $PairingToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    }
}

if (-not $PairingToken) {
    throw 'Pairing token is required. Pass via pipeline with -TokenStdin or enter when prompted.'
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$keyPath = Join-Path $ConfigDir 'nexus-device.key'
$envPath = Join-Path $ConfigDir 'worker.env'
if ((Test-Path $keyPath) -or (Test-Path $envPath)) {
    throw "A pairing already exists in $ConfigDir. Revoke it in NEXUS before replacing it."
}

$PairingToken | & $node $pairEntry `
    --api-url $NexusUrl `
    --token-stdin `
    --name $Name `
    --key-path $keyPath `
    --env-path $envPath `
    --allowed-paths ($AllowedPaths -join ',')
if ($LASTEXITCODE -ne 0) { throw "Pairing failed ($LASTEXITCODE)." }

# The key and configuration are initially readable only by the current user
# and administrators. The service script then replaces this ACL with only
# the virtual service account and administrators.
icacls $keyPath /inheritance:r /grant:r "$env:USERNAME:(R)" 'Administrators:(F)' | Out-Null
icacls $envPath /inheritance:r /grant:r "$env:USERNAME:(R)" 'Administrators:(F)' | Out-Null

$serviceScript = Join-Path $InstallDir 'install-worker-service.ps1'
& powershell -ExecutionPolicy Bypass -File $serviceScript `
    -InstallDir $InstallDir -EnvFile $envPath
foreach ($path in $AllowedPaths) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    icacls $path /grant:r 'NT SERVICE\nexus-worker:(OI)(CI)(M)' | Out-Null
}
if (-not $NoStart) { sc.exe start nexus-worker | Out-Null }

Write-Host ''
Write-Host 'Installation complete. Now approve this device in NEXUS > Devices.'
