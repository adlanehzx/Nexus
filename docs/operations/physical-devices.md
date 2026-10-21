# Testing on physical devices

## Why this procedure exists

Everything above is covered by tests: the handshake, the policies, long outages, dictation. None
of those tests touches a real device — they cannot. Three things only become visible with hardware
in your hands:

1. **System permissions.** Android and iOS ask for the microphone, notifications, accessibility. A
   denied permission does not look like an application bug: it looks like an application doing
   nothing.
2. **What happens when the screen goes off.** A worker killed by battery optimisation, a socket
   closed by flight mode, an accessibility service disabled by a system update.
3. **The gesture.** Scanning a QR code, approving a confirmation one-handed, talking to your phone
   in a noisy room. You do not measure that; you observe it.

Every section below has an **observable criterion**. Not "check that it works", but what you must
see, and what to do if you do not see it.

## Before you start

| to prepare                                        | why                                              |
| ------------------------------------------------- | ------------------------------------------------ |
| a NEXUS instance reachable from the phone's Wi-Fi | a phone that scans `localhost` calls itself      |
| `PUBLIC_API_URL` set to the local network address | without it, issuing the QR code is refused       |
| a **signed** APK                                  | an unsigned APK does not install                 |
| the USB cable and `adb`                           | without a log, a failure on a phone is guesswork |

```sh
nexus doctor                  # is the installation sound?
nexus policy check --path ~/  # what does the local policy decide?
adb logcat -s NexusWorker:V   # what the worker says, live
```

## 1. QR pairing

| step                                      | observable criterion                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| show the QR code from an authenticated UI | the payload starts with `nexus://pair`                       |
| scan it with the phone                    | the device appears in the list, **not approved** and offline |
| approve it                                | the device becomes `TRUSTED`, then `ONLINE` on first session |
| rescan **the same** QR code               | refused — a code serves once                                 |
| wait five minutes, then scan              | refused — the ticket expired                                 |

**If the device never appears**: the phone cannot reach the address in the QR code. From the phone,
open `http://<address>:3000/api/v1/health` in the browser. If that fails, it is the network, not
NEXUS.

## 2. Android permissions

| step                                                      | observable criterion                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| first launch                                              | the system asks for notifications, and nothing else                                   |
| enable the accessibility service                          | the NEXUS screen confirms it, and `android.app.open` appears core-side                |
| **deny** accessibility                                    | the matching capabilities are not advertised — not advertised then refused one by one |
| revoke the permission from Android settings while running | the worker notices, withdraws the capability, and does not crash                      |

The last one is what breaks in practice: a permission removed during execution is silent on the
application side.

## 3. Screen off, battery, network

| step                                           | observable criterion                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| screen off for 30 minutes, then hand it a task | it arrives — or it fails **plainly**, never "in progress" forever                                              |
| enable battery optimisation for NEXUS          | the worker is killed; on waking it reconnects with a full handshake                                            |
| flight mode for 10 minutes                     | the device goes offline core-side, and a task handed over during that time is refused rather than left waiting |
| cut the Wi-Fi **mid-task**                     | the task fails with a readable reason, and the result does not arrive twice after reconnection                 |

The last one matters most, and it is the only one the long-outage tests cannot reproduce exactly:
they kill a channel, not a radio.

## 4. Confirmations

| step                                                | observable criterion                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| trigger a risky action                              | the confirmation card arrives on the phone, with the **real** arguments |
| approve                                             | the action runs exactly once                                            |
| refuse                                              | the action does not run, and the agent does not retry it                |
| let it expire (2 min for `CRITICAL`)                | the action does not run, and the message says so                        |
| approve from **another** device of the same account | accepted — it is the same person                                        |

**What must be impossible**: approving a `CRITICAL` action by voice. If it works, that is a
regression.

## 5. Voice

| step                                      | observable criterion                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `nexus voice check`                       | the four dependencies are named, present or absent                        |
| `nexus voice dictate --seconds 5`         | the text appears, and `~/.nexus/audio-temporaire` is **empty** afterwards |
| dictate in a noisy room                   | the transcript is poor — that is expected; it must not be _empty_         |
| talk over NEXUS while it speaks           | the sound stops **immediately**, not a second later                       |
| hands-free conversation, then stay silent | it stops by itself                                                        |

The empty directory after dictation is the criterion that counts: it is the only end-to-end check
of "no audio is kept" on real hardware.

```sh
ls -la ~/.nexus/audio-temporaire    # must be empty
```

## 6. Global pause

| step                             | observable criterion                                          |
| -------------------------------- | ------------------------------------------------------------- |
| pause                            | a task handed over from the phone is refused, with the reason |
| read while paused                | conversations and history stay accessible                     |
| resume                           | the next task goes through                                    |
| restart the API **while paused** | it starts paused, and the log says so                         |

## 7. Revocation

| step                          | observable criterion                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| revoke the device             | it loses the connection immediately, not when its session expires |
| relaunch the app on the phone | it does not reconnect                                             |
| re-pair with a new QR code    | a **new** device appears; the old one stays `REVOKED`             |

## What to do with a failure

Write down three things: what you expected, what happened, and the matching log line (`adb
logcat`, Event Viewer, or `journalctl --user -u nexus-mission-engine`). A report without a log line
costs its reader a full reproduction.

If the failure is reproducible and the automated tests pass, then the thing is not tested — and
that is the most useful piece of information in this whole procedure.
