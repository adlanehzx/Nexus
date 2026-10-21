; Installateur du worker NEXUS pour Windows.
;
; Le MSI produit par Tauri installe la *coquille de bureau*. Le worker est autre
; chose : un démon Node sans interface, qui doit tourner sans session ouverte.
; D'où un installateur à lui.
;
; NSIS et non MSI : un MSI demande WiX et une chaîne de construction
; supplémentaire, pour un gain nul ici — nous n'avons ni déploiement par
; stratégie de groupe ni désinstallation pilotée à distance. NSIS produit un
; exécutable unique, et `makensis` tourne sur le runner Windows comme en local.
;
; Construction :
;   makensis -DVERSION=1.0.0 -DSOURCE_DIR=..\..\services\windows-worker nexus-worker.nsi

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef SOURCE_DIR
  !define SOURCE_DIR "..\..\services\windows-worker"
!endif

Name "NEXUS — exécutant"
OutFile "nexus-worker-${VERSION}-setup.exe"
Unicode true

; Par machine, et non par utilisateur : un service Windows est une ressource de
; la machine, et l'installer dans le profil d'un utilisateur produirait un
; service dont les fichiers disparaissent quand ce profil est supprimé.
InstallDir "$PROGRAMFILES64\NEXUS\worker"
RequestExecutionLevel admin

!define MUI_ABORTWARNING
; Pas de page de licence : le dépôt n'en porte pas, et pointer un fichier
; absent fait échouer `makensis` — un installateur qui ne se construit pas est
; plus coûteux qu'une page en moins.
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Section "Worker" SecWorker
  SetOutPath "$INSTDIR"

  ; Le code compilé et ses dépendances. `dist` doit exister : l'installateur ne
  ; compile pas, il installe — et confondre les deux donne un installateur qui
  ; échoue sur une machine sans outils de développement.
  File /r "${SOURCE_DIR}\dist"
  File /r "${SOURCE_DIR}\node_modules"
  File "${SOURCE_DIR}\package.json"
  ; Le script de service est installé avec le worker : le message final y
  ; renvoie, et un message qui désigne un fichier absent est pire que pas de
  ; message.
  File "install-worker-service.ps1"
  File "setup-worker.ps1"

  ; Le modèle de configuration, jamais la configuration : `.env` contient le
  ; chemin de la clé privée de CETTE machine, donc il se remplit après
  ; l'installation et ne doit pas être écrasé par une mise à jour.
  SetOverwrite off
  File /oname=.env.example "${SOURCE_DIR}\.env.example"
  SetOverwrite on

  ; La configuration n'est pas créée ici : setup-worker.ps1 la produit seulement
  ; après avoir consommé un ticket valide. Créer un modèle à cet emplacement
  ; ferait croire à setup qu'une identité existe déjà et bloquerait l'appairage.
  CreateDirectory "$COMMONAPPDATA\NEXUS"

  ; Node n'est pas embarqué. L'embarquer figerait une version qu'il faudrait
  ; mettre à jour nous-mêmes à chaque correctif de sécurité de Node — or ce
  ; worker exécute des commandes sur la machine, c'est le dernier endroit où
  ; l'on veut un runtime en retard.
  nsExec::ExecToStack 'cmd /c where node'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Node 24 est requis et n'a pas été trouvé.$\n$\nInstallez-le (https://nodejs.org) puis relancez cet installateur."
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "DisplayName" "NEXUS — exécutant"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "Publisher" "NEXUS"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "NoModify" 1

  ; Le service **n'est pas** installé automatiquement, et c'est une décision.
  ;
  ; Il faut d'abord appairer la machine. Un service installé et démarré avant
  ; cela échoue en boucle et masque la cause réelle.
  DetailPrint "Service non installé : appairez d'abord la machine depuis NEXUS > Appareils"
SectionEnd

Function .onInstSuccess
  MessageBox MB_ICONINFORMATION \
    "Worker installé.$\n$\nDans NEXUS > Appareils, créez un code d'appairage puis lancez :$\n$\npowershell -ExecutionPolicy Bypass -File $INSTDIR\setup-worker.ps1 -NexusUrl https://votre-nexus -PairingToken VOTRE_CODE"
FunctionEnd

Section "Uninstall"
  ; Le service d'abord : supprimer les fichiers d'un service en marche laisse un
  ; service qui redémarre en boucle sur un binaire absent.
  nsExec::ExecToLog 'sc.exe stop nexus-worker'
  nsExec::ExecToLog 'sc.exe delete nexus-worker'

  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\.env.example"
  Delete "$INSTDIR\install-worker-service.ps1"
  Delete "$INSTDIR\setup-worker.ps1"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker"

  ; La configuration et les journaux restent. Une désinstallation qui emporte
  ; l'identifiant d'appareil et le chemin de la clé obligerait à réappairer
  ; après une simple mise à jour — et une mise à jour passe par une
  ; désinstallation.
  MessageBox MB_ICONINFORMATION \
    "Worker désinstallé.$\n$\nLa configuration est conservée dans $COMMONAPPDATA\NEXUS.$\nSupprimez-la à la main si vous ne réinstallerez pas."
SectionEnd
