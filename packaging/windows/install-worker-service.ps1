<#
.SYNOPSIS
    Installe le worker NEXUS comme service Windows.

.DESCRIPTION
    Le worker doit tourner **sans session ouverte** : un assistant qui n'exécute
    une tâche que lorsque quelqu'un est connecté ne sert à rien le matin, quand
    on lui demande depuis son téléphone d'avoir préparé quelque chose.

    Trois décisions, et leurs raisons.

    1. **Compte de service, pas SYSTEM.** `LocalSystem` donnerait au worker les
       droits complets de la machine, ce qui annulerait l'intérêt de la
       politique locale : les refus par chemin ne protègent plus rien si le
       processus peut tout. Le service tourne donc sous un compte dédié, ou sous
       le compte de l'utilisateur si on préfère garder l'accès à ses dossiers.

    2. **Redémarrage automatique, mais borné.** Un worker qui plante en boucle
       et redémarre immédiatement transforme un défaut en charge. Le délai
       croît, et après trois échecs Windows attend une minute.

    3. **Aucun secret en argument.** La clé privée est désignée par un CHEMIN.
       Une ligne de commande de service est lisible par tout le monde dans le
       gestionnaire de tâches.

    Ce script n'invente pas de gestionnaire de services : il utilise `sc.exe`,
    présent partout, plutôt qu'un empaqueteur tiers à installer d'abord.

.PARAMETER InstallDir
    Dossier d'installation du worker (contenant `dist/main.js`).

.PARAMETER NodeExe
    Chemin de node.exe. Par défaut, celui du PATH.

.PARAMETER ServiceAccount
    Compte sous lequel le service tourne. Par défaut `NT SERVICE\nexus-worker`,
    un compte de service virtuel sans mot de passe à gérer.

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
    throw "node.exe introuvable. Installez Node 24 ou passez -NodeExe."
}
$entry = Join-Path $InstallDir 'dist\main.js'
if (-not (Test-Path $entry)) {
    throw "Point d'entrée absent : $entry. Lancez d'abord « pnpm build »."
}
if (-not (Test-Path $EnvFile)) {
    # Refuser plutôt que démarrer un service qui échouera à la première tâche,
    # loin de sa cause.
    throw "Configuration absente : $EnvFile. Lancez d'abord setup-worker.ps1."
}

# Les droits sur .env comptent autant que son contenu : il désigne le chemin de
# la clé privée de cette machine.
$acl = Get-Acl $EnvFile
$inherited = $acl.Access | Where-Object { $_.IsInherited -eq $true }
if ($inherited) {
    Write-Warning "$EnvFile hérite de droits du dossier parent. Restreignez-le : icacls `"$EnvFile`" /inheritance:r /grant:r `"$env:USERNAME:(R)`""
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "Service existant : arrêt et suppression avant réinstallation."
    sc.exe stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

# `binPath` cite node ET le script : un chemin d'installation avec un espace
# — « C:\Program Files\… » — casse un service dont la ligne n'est pas citée, et
# le symptôme est un service qui ne démarre pas sans dire pourquoi.
$binPath = "`"$NodeExe`" --env-file=`"$EnvFile`" `"$entry`""

$createArgs = @(
    'create', $ServiceName,
    "binPath= $binPath",
    'start= delayed-auto',
    'DisplayName= NEXUS — exécutant local'
)
if ($ServiceAccount) {
    $createArgs += "obj= $ServiceAccount"
}
sc.exe @createArgs
if ($LASTEXITCODE -ne 0) { throw "sc.exe create a échoué ($LASTEXITCODE)." }

# Le compte virtuel n'existe qu'apres `sc create`. Lui donner seulement les
# deux lectures indispensables ; les racines de travail sont accordees par le
# script d'installation, a partir de la liste explicite de l'utilisateur.
$credentialLine = Get-Content $EnvFile | Where-Object { $_ -match '^DEVICE_CREDENTIAL_PATH=' } | Select-Object -First 1
if (-not $credentialLine) { throw 'DEVICE_CREDENTIAL_PATH absent de la configuration.' }
$credentialPath = $credentialLine.Substring('DEVICE_CREDENTIAL_PATH='.Length)
icacls $EnvFile /inheritance:r /grant:r "${ServiceAccount}:(R)" 'Administrators:(F)' | Out-Null
icacls $credentialPath /inheritance:r /grant:r "${ServiceAccount}:(R)" 'Administrators:(F)' | Out-Null

sc.exe description $ServiceName 'Exécute les tâches NEXUS confiées à cette machine. Applique la politique locale ~/.nexus/device-policy.yaml.' | Out-Null

# Redémarrage borné : 5 s, 30 s, puis 60 s, et le compteur se remet à zéro au
# bout d'une journée. Un worker qui plante en boucle ne doit pas devenir une
# charge pour la machine ni pour le cœur.
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

Write-Host ""
Write-Host "Service « $ServiceName » installé."
Write-Host "  Démarrer   : sc.exe start $ServiceName"
Write-Host "  Journal    : Observateur d'événements → Journaux Windows → Application"
Write-Host "  Désinstaller: sc.exe stop $ServiceName ; sc.exe delete $ServiceName"
Write-Host ""
Write-Host "Le service démarre en « delayed-auto » : après les services système,"
Write-Host "pour ne pas allonger le démarrage de la machine."
