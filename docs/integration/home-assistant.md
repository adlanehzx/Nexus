# Domotique: zero-configuration setup (Lab 4)

NEXUS is the brain and Home Assistant (HA) is the hands. HA speaks the device
protocols: Wi-Fi plugs and bulbs, Zigbee, Matter, TVs, media players. NEXUS
finds HA, connects to it, reads every entity live, and decides what to do:
dashboard controls, scenes, routines, agent tools and voice satellites.

Nothing in this setup depends on a particular home. NEXUS ships with no IP
address, room, time zone or device list. Anyone who runs NEXUS on their LAN
gets the same flow:

1. NEXUS finds Home Assistant on the network and sets it up, or signs in to it.
2. ESP32 satellites find NEXUS on the network and ask to join. The person
   approves each one in the dashboard.
3. Rooms come from Home Assistant areas, and devices from what HA and the
   satellites report.

NEXUS never invents devices. Until HA is connected, the Domotique page says
so, and lists only the devices NEXUS reaches itself.

## 1. Home Assistant

### Use an existing Home Assistant

If HA already runs somewhere on the LAN (HA OS, a container or a NAS), do
nothing: NEXUS finds it in the next step.

### Or turn on the one bundled with NEXUS: one switch

Go to **Domotique**, then **Home Assistant**, and use the **Home Assistant
bundled with NEXUS** switch. Only an administrator, the first NEXUS account,
can use it.

- **On:**
  - The first time, NEXUS downloads the pinned image
    `ghcr.io/home-assistant/home-assistant:2026.10.4`, about 1.5 GB, and shows
    the progress.
  - It then creates and starts the container, with host networking (port
    `8123`) and a **1 GB memory cap**.
  - The switch shows the live memory use. A home with few integrations
    usually needs 200 to 350 MB; it grows with cameras, Bluetooth and long
    history.
  - The connection wizard below detects it as soon as it answers. The first
    start takes one to two minutes.
- **Off:** the container stops and uses no memory. Its configuration, in the
  `nexus_homeassistant-config` volume, is kept for the next time.
- **After a reboot:** the container returns in the state you left it.

How it works: the switch goes through **`home-supervisor`**, a small service
of about 30 MB. It is the only NEXUS process with access to the Docker socket,
and it can only inspect, create, start and stop the one `nexus-homeassistant`
container, with a fixed image, volume and memory cap. The API itself never
touches Docker: it talks to the supervisor through a private Unix socket. When
the supervisor is not running, for example with the API started outside
compose, the switch says so.

Settings:

| Variable                      | Effect                                        |
| ----------------------------- | --------------------------------------------- |
| `HOME_ASSISTANT_IMAGE`        | Pinned image.                                 |
| `HOME_ASSISTANT_MEMORY_MB`    | Memory cap for the switch (default `1024`).   |
| `HOME_ASSISTANT_MEMORY_LIMIT` | Memory cap for the compose profile.           |
| `DOCKER_SOCKET_PATH`          | Docker socket path, e.g. for rootless Docker. |

From the command line, `pnpm docker:home` starts the same Home Assistant
(compose `home` profile, same configuration volume). Use one way or the
other: the switch, or the command line.

### Connect, in the dashboard

Open **Domotique**, then **Home Assistant**. NEXUS searches the network by
itself, using mDNS `_home-assistant._tcp`, the bundled container and
`homeassistant.local`. It lists every instance it finds:

- **New installation**: click **Set up automatically**. NEXUS completes HA's
  onboarding on your behalf. It creates the HA owner account, using your
  NEXUS display name and the username `nexus` with a strong random password,
  and shows those credentials **once** so you can open HA's own interface
  later. It then creates its own long-lived token and connects.
- **Already set up**: click **Sign in** and enter the HA username and
  password. NEXUS uses them once to create its own long-lived token. It never
  stores the password. Accounts with two-factor authentication must use the
  advanced option below.
- **Not listed** (other subnet, remote access): enter the URL in
  **Settings**. Optionally paste a long-lived token there; this is the
  advanced path.

How NEXUS handles the token:

- It goes into the NEXUS secret vault: the Linux keyring, or the
  `MASTER_KEY`-encrypted file vault. The database keeps only a `vault://`
  reference.
- The token is never returned, logged or displayed.

The connection status (`connecting`, `connected`, `unreachable` with the next
retry time, `auth_failed`, `token_missing`) is shown live. When the connection
drops, NEXUS reconnects with exponential backoff and jitter, from 1 s up to
60 s. A rejected token is never retried.

### What Home Assistant found on your network

Once connected, the same tab lists the integrations HA discovered by itself:
Hue bridges, Cast and Android TVs, Shelly and TP-Link plugs, and so on.
**Add** confirms them from NEXUS. Some devices ask for a physical action, such
as pressing the Hue bridge button or entering a TV code. NEXUS says so, and
the step is completed in HA.

### Rooms and time zone

- Every HA area becomes a NEXUS room. You can rename it in NEXUS; to remove
  it, delete the area in HA. You can also create NEXUS-only rooms and move any
  device into any room.
- Routine schedules use **Home Assistant's time zone** once connected, else
  the host's. `NEXUS_HOME_TIMEZONE` forces a value if needed.

## 2. ESP32 satellites

Power on a satellite on the same network. Then:

1. It finds NEXUS by itself (mDNS `_nexus._tcp.local`) and announces itself.
2. It appears in **Domotique**, **Satellites vocaux**, under **Satellites on
   your network**.
3. Type the 6-digit code the satellite gives (voice, screen, LED or serial
   console), pick a name and a room, and click **Approve**.

The person who approves a satellite becomes its owner. Nothing goes into
`.env`. The full protocol is in
[esp32-voice-satellite-protocol.md](esp32-voice-satellite-protocol.md).

The legacy static configuration (`SATELLITE_TOKEN_HASHES_JSON`,
`SATELLITE_OWNERS_JSON`) still works, but nothing requires it.

## 3. TVs

- **Recommended:** let Home Assistant handle the TV (Android TV, Cast, LG,
  Samsung, Sony…). It then appears in the Home tab like any other device.
- **Direct ADB** (Fire TV / Android TV): enable _ADB debugging_ on the TV, open
  the **TV** tab and add its address (`host:5555`). Each account lists its own
  TVs, and the remote can only target those. NEXUS does not relay arbitrary
  ADB commands. `FIRE_TV_ADB_SERIAL` still declares one install-wide TV if you
  want one.

## 4. Sensitive devices

By default, actions on **locks, alarm panels, heating (`climate`) and water
heaters** require explicit confirmation, through the NEXUS confirmation flow:
a dashboard prompt plus a notification. `unlock` and `alarm_disarm` always
require confirmation.

You can change these classes in the Home Assistant tab, and flag any single
device from its card, for example a plug that feeds a heater. A confirmation
that is never answered expires and counts as a refusal.

These rules apply to the dashboard, the API, scenes, routines, agent tools and
voice commands.

## 5. Optional MQTT broker

For Zigbee2MQTT or MQTT-based devices, start the broker:

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile mqtt \
  run --rm mosquitto mosquitto_passwd -c /mosquitto/auth/passwd nexus
pnpm docker:mqtt
```

Anonymous access is disabled. The broker listens on loopback by default; set
`MQTT_BIND=0.0.0.0` for devices on the LAN.

## 6. API summary

| Method and path                                                                                                  | Purpose                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET` / `POST /api/v1/domotique/home-assistant/bundled`                                                          | Bundled Home Assistant state and memory use; turn it on or off (admin).                       |
| `GET /api/v1/domotique/home-assistant/discover`                                                                  | Home Assistant instances on the LAN, with their onboarding state.                             |
| `POST /api/v1/domotique/home-assistant/auto-setup`                                                               | Onboard a fresh HA and connect to it. Credentials are returned once.                          |
| `POST /api/v1/domotique/home-assistant/login`                                                                    | Connect with HA credentials, used once and never stored.                                      |
| `GET /api/v1/domotique/home-assistant` / `POST …` / `DELETE …`                                                   | Status (never the token), manual configuration, unlink.                                       |
| `GET /api/v1/domotique/home-assistant/discovered`, `POST …/discovered/:flowId/accept`                            | Integrations HA found on the LAN.                                                             |
| `GET /api/v1/domotique/devices`, `PATCH …/devices/:id`                                                           | Unified registry; room, alias, sensitivity, hidden.                                           |
| `POST /api/v1/devices/:id/actions`                                                                               | Run an action, validated per capability. Returns `202` and a `confirmationId` when sensitive. |
| `…/domotique/rooms`, `…/scenes`, `…/routines`, `GET …/logs`                                                      | Rooms, scenes, routines, execution log.                                                       |
| `GET/POST/DELETE /api/v1/domotique/tvs`                                                                          | The account's ADB TVs.                                                                        |
| `POST /api/v1/satellites/enroll`, `POST …/enroll/status`                                                         | Satellite side of enrolment. Private network only.                                            |
| `GET /api/v1/satellites/enrollments`, `POST …/:id/approve`, `POST …/:id/reject`, `DELETE /api/v1/satellites/:id` | Approval and management of satellites.                                                        |
| `GET /api/v1/devices/topology`                                                                                   | Rooms with their devices, from real data only.                                                |

Device ids: `ha:<entity_id>`, `sat:<satellite id>`, `firetv:<adb serial>`,
`nexus:<worker id>`.
