# Home Assistant onboarding (Lab 4: Domotique)

NEXUS is the brain and Home Assistant (HA) is the hands. HA speaks the device
protocols (Wi-Fi plugs and bulbs, Zigbee, Matter, TVs, media players). NEXUS
connects to it, reads every entity live, and decides what to do: dashboard
controls, scenes, routines, agent tools and voice satellites.

NEXUS never invents devices. Until HA is connected, the Domotique page shows
"not connected" and lists only the devices NEXUS reaches itself: ESP32
satellites, the Fire TV over ADB, and paired NEXUS workers.

## 1. Start Home Assistant

Home Assistant ships in `infrastructure/docker/docker-compose.yml` under the
`home` profile. It is pinned to `ghcr.io/home-assistant/home-assistant:2026.10.4`.
To change the version, set `HOME_ASSISTANT_IMAGE` in `.env`.

```bash
pnpm docker:home
# equivalent to:
docker compose -f infrastructure/docker/docker-compose.yml --env-file .env --profile home up -d homeassistant
```

- **Networking:** the container uses `network_mode: host`, because mDNS, SSDP,
  HomeKit and Cast discovery only work inside the LAN broadcast domain. HA
  listens on port **8123** of the host, at `http://<host-ip>:8123`.
- **Persistence:** the configuration lives in the `homeassistant-config`
  volume, which survives `docker compose down`. Only `down -v` deletes it.
- **Timezone:** set `NEXUS_HOME_TIMEZONE` in `.env`. The default is
  `Europe/Paris`. NEXUS uses the same variable to evaluate routine schedules.

The first boot takes one to two minutes. The healthcheck turns `healthy` once
`http://127.0.0.1:8123` answers.

### Optional: MQTT broker

If you plan to add Zigbee2MQTT or MQTT-based ESP32 devices, a Mosquitto broker
is available under the `mqtt` profile. Anonymous access is disabled, so create
a user first:

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile mqtt \
  run --rm mosquitto mosquitto_passwd -c /mosquitto/auth/passwd nexus
pnpm docker:mqtt
```

The broker listens on `127.0.0.1:1883` by default. To accept devices from the
LAN, set `MQTT_BIND=0.0.0.0`. To connect HA to it, go to _Settings → Devices &
services → Add integration → MQTT_ and enter host `127.0.0.1` with the user you
created.

## 2. Create your Home Assistant account

1. Open `http://<host-ip>:8123` in a browser.
2. Create the owner account. This is a local HA account, separate from your
   NEXUS account.
3. Set the home location, the unit system and the timezone.
4. HA lists the devices it discovered on the network: Wi-Fi plugs, Hue,
   Chromecast, smart TVs and so on. Add the ones you want.
5. Create **areas** such as Salon, Cuisine or Bureau, and assign devices to
   them (_Settings → Areas_). NEXUS imports these areas as rooms
   automatically.

## 3. Generate a long-lived access token

1. In HA, click your user name at the bottom left to open your **profile**.
2. Open the **Security** tab.
3. Under **Long-lived access tokens**, click **Create token**, then name it
   `NEXUS`.
4. Copy the token right away. HA shows it only once.

The token acts with your HA user's rights. To revoke it, delete it from the
same screen. NEXUS then shows `auth_failed` and stops retrying.

## 4. Paste it in NEXUS

1. In the NEXUS dashboard, open **Domotique**, then the **Home Assistant** tab.
2. Enter the URL, for example `http://192.168.1.10:8123`. The API also uses
   host networking, so when HA runs on the same machine,
   `http://127.0.0.1:8123` works too.
3. Paste the token and click **Save and connect**.

What happens next:

- NEXUS checks the URL and token with `GET /api/config`. If HA rejects the
  token, NEXUS refuses it and does not store it.
- The token goes into the NEXUS secret vault: the Linux keyring, or the
  `MASTER_KEY`-encrypted file vault. The database keeps only a `vault://`
  reference. The API never returns, logs or displays the token. The dashboard
  only shows whether a token is stored.
- NEXUS opens the HA WebSocket (`/api/websocket`), authenticates, subscribes
  to `state_changed`, and reads the area, device and entity registries.
- Each HA area becomes a NEXUS room. You can rename these rooms in NEXUS. To
  remove one, delete the area in HA. You can also create NEXUS-only rooms and
  move any device into any room.

The connection status (`connecting`, `connected`, `unreachable` with the next
retry time, `auth_failed`, `token_missing`) is shown live. When the connection
drops, NEXUS reconnects with exponential backoff and jitter, from 1 s up to
60 s. A rejected token is never retried.

## 5. Sensitive devices

Actions on **locks, alarm panels, heating (`climate`) and water heaters**
require explicit confirmation by default, through the existing NEXUS
confirmation flow: a dashboard prompt plus a notification. `unlock` and
`alarm_disarm` always require confirmation.

You can change the sensitive classes in the Home Assistant tab. You can also
flag any single device as sensitive from its card, for example a plug that
feeds a heater. A confirmation that is never answered expires and counts as a
refusal.

This applies to every path: dashboard buttons, `POST /api/v1/devices/:id/actions`,
scenes, routines, agent tools (`home.device_control`, `home.scene_run`) and
voice commands.

## 6. API summary

| Method and path                                         | Purpose                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/v1/domotique/home-assistant`                  | Link and live connection status (never the token).                                                    |
| `POST /api/v1/domotique/home-assistant`                 | Set `baseUrl`, `token` (write-only), `enabled` and `sensitiveClasses`.                                |
| `POST /api/v1/domotique/home-assistant/test` / `resync` | Probe the connection, or force a registry resync.                                                     |
| `DELETE /api/v1/domotique/home-assistant`               | Unlink and delete the token from the vault.                                                           |
| `GET /api/v1/domotique/devices`                         | Unified registry: HA, satellites, Fire TV and workers.                                                |
| `PATCH /api/v1/domotique/devices/:id`                   | Set room, alias, sensitivity or hidden.                                                               |
| `POST /api/v1/devices/:id/actions`                      | Run an action, validated per capability. Returns `202` with a `confirmationId` for sensitive devices. |
| `GET/POST/PATCH/DELETE /api/v1/domotique/rooms`         | Rooms.                                                                                                |
| `.../domotique/scenes`, `POST .../scenes/:id/run`       | Scenes.                                                                                               |
| `.../domotique/routines`, `POST .../routines/:id/run`   | Routines: time (cron), device state and presence placeholder.                                         |
| `GET /api/v1/domotique/logs`                            | Execution log.                                                                                        |
| `GET /api/v1/devices/topology`                          | Rooms with their devices, from real data only.                                                        |

Device ids: `ha:<entity_id>`, `sat:<satellite id>`, `firetv:<adb serial>`,
`nexus:<worker id>`.
