# Arch Linux Packaging (`nexus-desktop`)

This directory contains the Arch Linux `PKGBUILD` for building and packaging the native NEXUS desktop shell (`nexus-desktop`) from source.

## Prerequisites

The package requires the following native libraries and toolchains:

- **Runtime dependencies**:
  - `webkit2gtk-4.1` (WebKit rendering engine for Tauri webview)
  - `gtk3` (UI toolkit)
  - `libappindicator-gtk3` (system tray support)
  - `librsvg` (SVG icon rendering)
  - Secret Service daemon (e.g. `gnome-keyring` or `keepassxc`) for credential storage
- **Build dependencies**:
  - `rust` and `cargo`
  - `nodejs` (>= 24.20.0)
  - `pnpm` (>= 11.25.0)
  - `git`

## Building and Installing

Run from within `packaging/arch`:

```sh
cd packaging/arch
makepkg -si
```

This compiles the monorepo, builds the Tauri desktop shell, and installs `/usr/bin/nexus-desktop`, desktop entry `/usr/share/applications/nexus-desktop.desktop`, and icons into standard system paths.

## Uninstallation

To remove the package via pacman:

```sh
sudo pacman -R nexus-desktop
```

To remove all local user data and credentials:

```sh
# User configuration and cache:
rm -rf ~/.config/nexus-desktop ~/.cache/nexus-desktop

# Credentials stored in Secret Service (service: fr.nexus.desktop)
# can be inspected and deleted via Seahorse (Passwords and Keys) or secret-tool:
secret-tool clear service fr.nexus.desktop
```
