# NEXUS Raspberry Pi Voice-Satellite

A lightweight, room-level voice and sensor satellite worker for NEXUS running on Raspberry Pi OS.

## 1. Supported Hardware

- **Single-board Computers**:
  - Raspberry Pi 3B+, 4B, 5 (recommended: 2GB+ RAM)
  - Raspberry Pi Zero 2W (voice-only mode)
- **Audio Interface**:
  - USB Microphone / Conference Speakerphone (Jabra, Anker, Blue Snowball)
  - ReSpeaker 2-Mic / 4-Mic Pi HAT
- **Physical Privacy Indicator**:
  - Optional LED connected to GPIO pin 17 (Pin 11) with a 330Ω resistor to ground (Pin 6).

## 2. Security Boundaries

- **Single-Use Pairing**:
  The installation consumes the pairing ticket generated from the NEXUS Dashboard strictly via STDIN:
  ```bash
  echo "$PAIRING_TICKET" | sudo bash install-satellite.sh --token-stdin --server-url http://nexus.local:3000
  ```
  Secrets are **never** passed via command line arguments (`argv`) to avoid leaking in `ps` process tables or shell histories.
- **Dedicated Unprivileged User**:
  Runs under the isolated `nexus-satellite` system user with `ProtectSystem=strict`, `ProtectHome=yes`, and `NoNewPrivileges=yes`.
- **Hardware-Visible Privacy State**:
  The GPIO LED illuminates physically whenever the microphone is active. When idle, the microphone stream is closed.
- **Zero-Retention Audio**:
  Recorded audio buffers are processed in volatile memory, streamed via encrypted TLS/WebSocket, and unlinked immediately. No permanent WAV/PCM recordings are retained on the satellite SD card.

## 3. Installation

1. On your NEXUS dashboard, navigate to **Devices** > **Pair New Device**.
2. Select **Raspberry Pi Voice Satellite** and generate a single-use pairing token.
3. On the Raspberry Pi, run:
   ```bash
   curl -fsSL https://nexus-assistant.local/install-satellite.sh -o install-satellite.sh
   echo "YOUR_SINGLE_USE_TOKEN" | sudo bash install-satellite.sh --token-stdin --server-url http://YOUR_NEXUS_SERVER:3000
   ```
4. Start the service:
   ```bash
   sudo systemctl enable --now nexus-voice-satellite.service
   ```

## 4. Verification and Status

Check service status and logs:

```bash
sudo systemctl status nexus-voice-satellite.service
sudo journalctl -u nexus-voice-satellite.service -f
```

## 5. Uninstallation

To cleanly and completely remove the service, user, and configuration:

```bash
sudo bash install-satellite.sh --uninstall
```
