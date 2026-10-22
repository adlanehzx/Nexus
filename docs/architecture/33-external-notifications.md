# 33 — Unified External Notifications

Describes the architecture of the NEXUS external notification subsystem, covering Linux desktop notifications, zero-cost mobile push, and chat webhooks.

Packages: [`@nexus/notifications`](../../packages/notifications), [`services/api`](../../services/api).

---

## 1. Architectural Principles

Notifications are **produced centrally**, never decentralised across individual clients.

```
NEXUS Events (Task completion, ConfirmationBroker, Alerts)
  │
  ▼
NotificationService (services/api)
  │
  ├── 1. PostgreSQL persistence (NotificationStore)
  ├── 2. Real-time WebSocket broadcasting (EventRouter)
  │
  ▼
NotificationDispatcher (@nexus/notifications)
  │
  ├── Quiet Hours evaluation (isQuietHours, urgent bypass)
  ├── Aggregation & Rate limiting (NotificationThrottler)
  │
  ├──▶ DesktopChannel (Linux notify-send)
  ├──▶ NtfyChannel (Mobile push via HTTP ntfy.sh)
  └──▶ WebhookChannel (Discord / Telegram / Apprise / Generic)
```

This decoupling guarantees:

1. **Global Consistency**: Every channel receives identical information with consistent severity levels.
2. **Resilience and Non-blocking Execution**: External service outages or network latency (e.g. ntfy server downtime) never interrupt running agents or tasks.
3. **Zero Secret Disclosure**: Webhook credentials and private topics are referenced via `vault://nexus/...` and resolved purely in memory without log leaks.

---

## 2. Notification Channels

### 2.1 Linux Desktop (`DesktopChannel`)

- Executes `/usr/bin/notify-send` via child process.
- Maps internal priorities to freedesktop urgency levels (`low`, `normal`, `critical`).
- Selects standard system icons (`dialog-information`, `dialog-warning`, `dialog-error`).
- Headless-tolerant: skips silently without throwing fatal errors if no Wayland/X11 display is available.

### 2.2 Free Mobile Push (`NtfyChannel`)

- Uses the standard HTTP [ntfy](https://ntfy.sh) protocol via `POST` requests.
- Operates on the public free tier `https://ntfy.sh` or private self-hosted instances.
- Sends structured HTTP headers:
  - `Title`: Notification header.
  - `Priority`: Urgency level 1 (min) to 5 (urgent).
  - `Tags`: Visual and category badges.
  - `Click`: Deep link URL directing the user to the relevant NEXUS resource.
  - `Actions`: Inline action buttons (`view, Open, <url>`).
- Supports optional Bearer authentication for restricted topics.

### 2.3 External Webhooks (`WebhookChannel`)

- Multi-platform formatting:
  - **Discord**: Rich embed with semantic color-coding and timestamp.
  - **Telegram**: HTML formatted message with `<b>` tags, direct links, and special character escaping.
  - **Apprise**: Payload schema compatible with universal Apprise instances.
  - **Generic**: Extensible JSON schema containing full event metadata.

---

## 3. Delivery Policies

### 3.1 Quiet Hours

- Configurable time window (e.g. `22:00` - `08:00`) with explicit timezone support (e.g. `Europe/Paris`).
- Handles midnight transitions automatically.
- **Urgent Bypass Rule**: Alerts flagged with `urgent` or `high` priority (such as human confirmations required to unblock waiting agents) bypass quiet hours when `allowUrgent` is enabled, while routine updates are silenced.

### 3.2 Throttling and Deduplication

- Prevents notification spam from rapid agent loops.
- `NotificationThrottler` enforces a sliding window (default 30 seconds) grouped by `groupKey` (e.g. `task-<taskId>` or `confirmation-<id>`).
- The initial alert is delivered immediately; subsequent alerts within the window are aggregated and reported when the window expires.

### 3.3 Direct Deep Links

- Task completions include direct links:
  `${dashboardBaseUrl}/dashboard?tab=tasks&taskId=<taskId>`
- Human confirmations provide instant approval links:
  `${dashboardBaseUrl}/dashboard?tab=confirmations&id=<confirmationId>`

---

## 4. Administration and Health Checks

The following administrative endpoints manage external notifications from the dashboard:

| Method | Route                                    | Description                                           |
| ------ | ---------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/v1/dashboard/notifications/config` | Reads current external channel configuration          |
| `PUT`  | `/api/v1/dashboard/notifications/config` | Updates external channels dynamically                 |
| `POST` | `/api/v1/dashboard/notifications/test`   | Dispatches a live test notification and returns stats |
