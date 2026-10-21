# NEXUS Windows Desktop Client

The desktop machine fulfills the **`BOTH`** role: it hosts the user interface to control NEXUS, and NEXUS executes tasks on it.

These two roles run as **two completely distinct processes**, which is the fundamental design
decision governing this entire package.

```
┌──────────────────────┐        ┌──────────────────────┐
│  apps/desktop        │        │  services/windows-   │
│  (this UI window)    │        │  worker (daemon)     │
│                      │        │                      │
│  user session tokens │        │  host private key    │
│  → /ws/client        │        │  → /ws/worker        │
└──────────┬───────────┘        └──────────┬───────────┘
           │                               │
           └───────────► NEXUS Core ◄──────┘
                     authorization, selection
```

There is **no IPC or direct channel** between the two processes. When the user requests an action
from the desktop window that this machine must perform, the request is sent over the network to the
NEXUS Core, authorized there, and routed back down through the authenticated worker channel. While
this routing path may seem roundabout for two adjacent processes on the same host, it guarantees that
a compromised UI window cannot directly become a command shell.

The only information the desktop UI reads from the local daemon is a **device identifier**, located in
`%ProgramData%\NEXUS\worker\device.json`. This grants no access privileges; it solely allows the UI to
recognize itself in the device list returned by the Core, avoiding the display of a duplicate phantom
device.

## Capabilities of the UI

Streaming chat, conversation management, task tracking, device list, human confirmations,
notifications, memory browsing, settings, and a local worker supervision panel — **read-only**.

## Restrictions of the UI

The UI cannot execute commands, spawn processes, read or write arbitrary filesystem paths, or talk
directly to Docker, Git, or the worker daemon. This is not just a policy: there is simply no code to
do so, and [`test/isolation.test.ts`](test/isolation.test.ts) breaks the build if such code is introduced.

## Directory Structure

| Path                       | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `src/lib/shell.ts`         | Shell abstraction port — and the list of rejected actions  |
| `src/lib/shells.ts`        | Tauri adapter, with browser fallback                       |
| `src/lib/platform.ts`      | `@nexus/client-core` ports tailored for the renderer       |
| `src/lib/nexus.tsx`        | Application wiring and React context providers             |
| `src/lib/worker-status.ts` | Local worker status derived from the Core's reported state |
| `src/lib/tasks.ts`         | Task request composition and submission                    |
| `src/lib/history.ts`       | Merging REST history with the real-time event stream       |
| `src/ui/`                  | React screens and UI components                            |
| `src-tauri/`               | Native desktop wrapper shell (Rust)                        |

## Development

```bash
pnpm --filter @nexus/desktop dev       # Vite only, runs in browser
pnpm --filter @nexus/desktop tauri dev # Native window (Rust toolchain required)
```

`VITE_NEXUS_URL` points to the Core. **No secrets** are embedded in the desktop bundle: desktop
executables can be decompiled just as easily as mobile binaries.

Outside the native shell, authentication tokens live **strictly in memory** and disappear on reload.
Storing refresh tokens in browser web storage would make them accessible to arbitrary page scripts
for 30 days.

## Known Limitations

`src-tauri/` **has not been compiled in CI**: the Rust toolchain is not preinstalled in the default
environment used for repository-wide checks. Everything above the `DesktopShell` abstraction port is
fully covered and verified.

