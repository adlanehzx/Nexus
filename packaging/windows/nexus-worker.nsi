; NEXUS worker installer for Windows.
;
; The MSI produced by Tauri installs the desktop shell. The worker is a
; headless Node daemon that must run without an interactive session.
;
; NSIS produces one executable and `makensis` runs both locally and in CI.
;
; Build:
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

Name "NEXUS — worker"
OutFile "nexus-worker-${VERSION}-setup.exe"
Unicode true

; Install per machine because a Windows service is a machine resource.
InstallDir "$PROGRAMFILES64\NEXUS\worker"
RequestExecutionLevel admin

!define MUI_ABORTWARNING
; Do not reference a license file that may be absent from a source archive.
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Worker" SecWorker
  SetOutPath "$INSTDIR"

  ; Install prebuilt code and dependencies. The installer never compiles source.
  File /r "${SOURCE_DIR}\dist"
  File /r "${SOURCE_DIR}\node_modules"
  File "${SOURCE_DIR}\package.json"
  ; Ship the service and pairing scripts referenced by the completion message.
  File "install-worker-service.ps1"
  File "setup-worker.ps1"

  ; Ship only the template. Never overwrite this machine's private configuration.
  SetOverwrite off
  File /oname=.env.example "${SOURCE_DIR}\.env.example"
  SetOverwrite on

  ; setup-worker.ps1 creates configuration only after consuming a valid ticket.
  CreateDirectory "$COMMONAPPDATA\NEXUS"

  ; Keep Node external so platform administrators can apply security updates.
  nsExec::ExecToStack 'cmd /c where node'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Node 24 is required and was not found.$\n$\nInstall it from https://nodejs.org, then run this installer again."
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "DisplayName" "NEXUS — worker"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "Publisher" "NEXUS"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NexusWorker" \
    "NoModify" 1

  ; Pair the machine before installing the service. Starting an unconfigured
  ; service would fail repeatedly and hide the actual cause.
  DetailPrint "Service not installed: pair this machine from NEXUS > Devices first"
SectionEnd

Function .onInstSuccess
  MessageBox MB_ICONINFORMATION \
    "Worker installed.$\n$\nIn NEXUS > Devices, create a pairing code, then run:$\n$\npowershell -ExecutionPolicy Bypass -File $INSTDIR\setup-worker.ps1 -NexusUrl https://your-nexus -PairingToken YOUR_CODE"
FunctionEnd

Section "Uninstall"
  ; Stop and remove the service before deleting its executable files.
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

  ; Preserve configuration and logs so an upgrade does not require pairing again.
  MessageBox MB_ICONINFORMATION \
    "Worker uninstalled.$\n$\nConfiguration remains in $COMMONAPPDATA\NEXUS.$\nRemove it manually if you do not plan to reinstall."
SectionEnd
