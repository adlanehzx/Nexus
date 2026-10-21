<# Appaire, configure et installe le worker NEXUS en une commande. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NexusUrl,
    [Parameter(Mandatory = $true)][string]$PairingToken,
    [string]$Name = $env:COMPUTERNAME,
    [string[]]$AllowedPaths = @((Join-Path $env:USERPROFILE 'Documents\NEXUS')),
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'NEXUS\worker'),
    [string]$ConfigDir = (Join-Path $env:ProgramData 'NEXUS'),
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node 24 ou plus recent est requis.' }

$pairEntry = Join-Path $InstallDir 'dist\pair.js'
if (-not (Test-Path $pairEntry)) { throw "Installateur incomplet : $pairEntry absent." }

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$keyPath = Join-Path $ConfigDir 'nexus-device.key'
$envPath = Join-Path $ConfigDir 'worker.env'
if ((Test-Path $keyPath) -or (Test-Path $envPath)) {
    throw "Un appairage existe deja dans $ConfigDir. Revoquez-le dans NEXUS avant de le remplacer."
}

$PairingToken | & $node $pairEntry `
    --api-url $NexusUrl `
    --token-stdin `
    --name $Name `
    --key-path $keyPath `
    --env-path $envPath `
    --allowed-paths ($AllowedPaths -join ',')
if ($LASTEXITCODE -ne 0) { throw "L'appairage a echoue ($LASTEXITCODE)." }

# La cle et la configuration ne sont d'abord lisibles que par l'utilisateur
# courant et les administrateurs. Le script de service remplace ensuite cette
# ACL par le seul compte virtuel du service et les administrateurs.
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
Write-Host 'Installation terminee. Approuvez maintenant cet appareil dans NEXUS > Appareils.'
