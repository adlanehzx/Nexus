import { useEffect, useState } from "react";
import {
  activeTasks,
  finishedTasks,
  unreadNotifications,
  type ApiMemoryHit,
} from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { TaskCard } from "./cards.js";
import type { LocalWorkerState } from "../lib/worker-status.js";

/**
 * Secondary screens.
 *
 * Tasks, devices, notifications, memory, local worker, settings. None
 * make autonomous decisions: they read the state published by the core and display it.
 *
 * One rule is constant across screens: **nothing here targets a specific machine directly.**
 * Neither the device list nor the local worker screen offers "run here". An action
 * is always routed to the core, which authorizes and schedules it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

export function Tasks() {
  const nexus = useNexus();
  const running = activeTasks(nexus.state);
  const completed = finishedTasks(nexus.state);

  const getDeviceName = (deviceId: string | null) =>
    deviceId === null
      ? undefined
      : (nexus.state.devices.find((device) => device.id === deviceId)?.name ?? deviceId);

  return (
    <div className="content">
      <h3>In progress ({running.length})</h3>
      {running.length === 0 ? (
        <p className="muted">No tasks in progress.</p>
      ) : (
        running.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            deviceName={getDeviceName(task.workerDeviceId)}
            onCancel={(taskId) => {
              void nexus.cancelTask(taskId);
            }}
          />
        ))
      )}

      <h3 style={{ marginTop: 24 }}>Completed ({completed.length})</h3>
      {completed.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        completed.map((task) => (
          <TaskCard key={task.id} task={task} deviceName={getDeviceName(task.workerDeviceId)} />
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Devices
// ─────────────────────────────────────────────────────────────────────────────

export function Devices() {
  const nexus = useNexus();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void nexus.refreshDevices().catch(() => undefined);
    // Initial fetch only: `refreshDevices` identity changes on re-renders,
    // so including it would cause a polling loop.
  }, []);

  const revoke = (deviceId: string, name: string) => {
    if (!globalThis.confirm(`Revoke "${name}"? You will need to pair it again.`)) return;

    setBusy(true);
    void nexus.api
      .revokeDevice(deviceId)
      .then(() => nexus.refreshDevices())
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="content">
      <div className="row" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            void nexus.refreshDevices().catch(() => undefined);
          }}
        >
          Refresh
        </button>
        <span className="muted">
          A device is attached to this window from Settings; it is not controlled from here.
        </span>
      </div>

      {nexus.state.devices.map((device) => (
        <article key={device.id} className="card">
          <header>
            <strong>
              {device.name}
              {device.id === nexus.boundDeviceId ? " — this window" : ""}
              {device.id === nexus.worker.deviceId ? " — worker for this machine" : ""}
            </strong>
            <span className={`tag ${device.status === "ONLINE" ? "ok" : "attention"}`}>
              {device.status}
            </span>
          </header>

          <div className="muted">
            role {device.role}
            {device.lastSeenAt === null ? "" : ` · seen ${device.lastSeenAt}`}
          </div>
          <div className="muted">
            {device.capabilities.length === 0
              ? "no declared capabilities"
              : device.capabilities.join(", ")}
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => {
                revoke(device.id, device.name);
              }}
            >
              Revoke
            </button>
          </div>
        </article>
      ))}

      {nexus.state.devices.length === 0 ? <p className="empty-state">No devices.</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

export function Notifications() {
  const nexus = useNexus();

  return (
    <div className="content">
      <p className="muted">
        Notifications are generated by the core and pushed to all your devices. Marked as read here,
        a notification is also marked as read on mobile.
      </p>

      {nexus.state.notifications.map((notification) => (
        <article key={notification.id} className="card">
          <header>
            <strong>{notification.title}</strong>
            <span
              className={`tag ${
                notification.severity === "error"
                  ? "ko"
                  : notification.severity === "warning"
                    ? "attention"
                    : ""
              }`}
            >
              {notification.severity}
            </span>
          </header>
          <div>{notification.body}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted">{notification.createdAt}</span>
            {notification.readAt === null ? (
              <button
                type="button"
                className="button"
                onClick={() => {
                  void nexus.markNotificationRead(notification.id);
                }}
              >
                Mark as read
              </button>
            ) : (
              <span className="muted">read</span>
            )}
          </div>
        </article>
      ))}

      {nexus.state.notifications.length === 0 ? (
        <p className="empty-state">Nothing to report.</p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

export function Memory() {
  const nexus = useNexus();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiMemoryHit[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const search = () => {
    if (query.trim().length === 0) return;
    void nexus.api
      .searchMemory(query.trim())
      .then(setResults)
      .catch(() => {
        setStatusMessage("Search failed.");
      });
  };

  const save = () => {
    if (newMemory.trim().length === 0) return;
    void nexus.api
      .storeMemory({ content: newMemory.trim() })
      .then(() => {
        setNewMemory("");
        setStatusMessage("Memory saved.");
      })
      .catch((cause: unknown) => {
        // The core provides reasons for rejection — secrets, or personal
        // data without consent. Replacing its error message with a generic failure
        // would hide the actionable diagnostic.
        setStatusMessage(cause instanceof Error ? cause.message : "Save failed.");
      });
  };

  return (
    <div className="content">
      <div className="row" style={{ marginBottom: 14 }}>
        <input
          className="field"
          value={query}
          placeholder="Search memory…"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") search();
          }}
        />
        <button type="button" className="button primary" onClick={search}>
          Search
        </button>
      </div>

      {results.map((hit) => (
        <article key={hit.id} className="card">
          <header>
            <span className="tag">{hit.kind}</span>
            <span className="muted">score {hit.score.toFixed(2)}</span>
          </header>
          <div>{hit.content}</div>
        </article>
      ))}

      <h3 style={{ marginTop: 24 }}>Add a memory</h3>
      <textarea
        className="field"
        rows={3}
        value={newMemory}
        placeholder="What NEXUS should remember…"
        onChange={(event) => {
          setNewMemory(event.target.value);
        }}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" className="button" onClick={save}>
          Save
        </button>
        {statusMessage === null ? null : <span className="muted">{statusMessage}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Local worker
// ─────────────────────────────────────────────────────────────────────────────

const STATE_TONE: Record<LocalWorkerState, string> = {
  absent: "",
  unpaired: "attention",
  pending: "attention",
  offline: "attention",
  degraded: "attention",
  online: "ok",
  revoked: "ko",
};

/**
 * Supervise the worker daemon installed on this machine.
 *
 * **Read-only** screen. Displays what the core knows about the machine: state,
 * capabilities, load. Contains no "run here" button, terminal console, or daemon log
 * viewer — UI and worker daemon are separate processes, and this window cannot
 * force actions onto the worker.
 *
 * To stop the worker, revoke the device: the action routes through the core,
 * is audited, and is visible on all clients.
 */
export function Worker() {
  const nexus = useNexus();
  const worker = nexus.worker;

  return (
    <div className="content">
      <article className="card">
        <header>
          <strong>{worker.name ?? "Local worker"}</strong>
          <span className={`tag ${STATE_TONE[worker.state]}`}>{worker.state}</span>
        </header>
        <div>{worker.summary}</div>

        {worker.deviceId === null ? null : (
          <>
            <div className="muted" style={{ marginTop: 8 }}>
              device {worker.deviceId}
            </div>
            <div className="muted">
              {worker.activeTasks}/{worker.maxConcurrentTasks} task(s) —{" "}
              {worker.acceptingTasks ? "accepting new steps" : "not accepting steps"}
            </div>
            <div className="muted">
              {worker.capabilities.length === 0
                ? "no declared capabilities"
                : worker.capabilities.join(", ")}
            </div>
          </>
        )}
      </article>

      <p className="muted">
        This screen displays what <strong>the core</strong> knows about the worker, not what the
        daemon reports on its own. The core view decides task routing; displaying anything else
        would mislead the interface.
      </p>

      <h3 style={{ marginTop: 24 }}>Other workers ({nexus.fleet.length})</h3>
      {nexus.fleet.map((device) => (
        <article key={device.id} className="card">
          <header>
            <strong>{device.name}</strong>
            <span className={`tag ${device.status === "ONLINE" ? "ok" : "attention"}`}>
              {device.status}
            </span>
          </header>
          <div className="muted">
            {device.capabilities.length === 0
              ? "no declared capabilities"
              : device.capabilities.join(", ")}
          </div>
        </article>
      ))}

      <p className="muted">
        Your workstation and phone appear here. They are not controlled from this list: a task
        declares required capabilities, and the core chooses the machine.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export function Settings() {
  const nexus = useNexus();
  const [speakReplies, setSpeakReplies] = useState(nexus.voice.speakRepliesEnabled);

  return (
    <div className="content">
      <article className="card">
        <header>
          <strong>This window</strong>
        </header>
        <div className="muted">
          shell: {nexus.shell.kind === "tauri" ? "Tauri (native window)" : "browser"}
        </div>

        {nexus.shell.kind === "web" ? (
          <p className="muted">
            Outside the native shell, tokens stay <strong>in memory</strong> and are cleared on page
            reload. This is intentional: storing a refresh token in browser storage would expose it
            to any script on the page.
          </p>
        ) : null}
      </article>

      <article className="card">
        <header>
          <strong>Attached device</strong>
        </header>
        <p className="muted">
          This window speaks to the core on behalf of a device. On this machine, it is the one
          paired by the worker daemon — the same ID serves both channels, with distinct secrets.
        </p>

        <select
          className="field"
          value={nexus.boundDeviceId ?? ""}
          onChange={(event) => {
            if (event.target.value.length > 0) {
              void nexus.bindDevice(event.target.value).catch(() => undefined);
            }
          }}
        >
          <option value="">— none —</option>
          {nexus.state.devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name} ({device.role})
            </option>
          ))}
        </select>
      </article>

      <article className="card">
        <header>
          <strong>Voice</strong>
        </header>
        <div className="muted">
          speech recognition: {nexus.voiceAvailable ? "available" : "unavailable on this machine"}
        </div>
        <label className="row" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={(event) => {
              setSpeakReplies(event.target.checked);
              nexus.voice.setSpeakReplies(event.target.checked);
            }}
          />
          Read responses aloud
        </label>
        <p className="muted">
          The microphone activates only while holding the button. No background listening exists,
          and the speech recognition port provides none.
        </p>
      </article>

      <article className="card">
        <header>
          <strong>Session</strong>
        </header>
        <button
          type="button"
          className="button danger"
          onClick={() => {
            void nexus.signOut().catch(() => undefined);
          }}
        >
          Sign out
        </button>
      </article>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function unreadCount(nexus: ReturnType<typeof useNexus>): number {
  return unreadNotifications(nexus.state).length;
}
