import { useState } from "react";
import type { ConfirmationView, MessageView, TaskView, ToolCallView } from "@nexus/client-core";

/**
 * Shared display building blocks.
 *
 * They are intentionally simple: they receive a view already computed by
 * `@nexus/client-core` and render it. None of them make decisions — no
 * filtering, no sorting, no status interpretation. What is decided is
 * tested, and what is tested does not live in a component.
 */

// ─────────────────────────────────────────────────────────────────────────────

export function MessageBubble({ message }: { message: MessageView }) {
  return (
    <div className={`bulle ${message.role}`}>
      {message.content}
      {message.streaming ? <span aria-label="streaming response"> ▌</span> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<TaskView["status"], string> = {
  pending: "queued",
  running: "running",
  waiting_for_confirmation: "awaiting confirmation",
  succeeded: "completed",
  partial: "partially completed",
  failed: "failed",
  cancelled: "cancelled",
};

function taskTone(status: TaskView["status"]): string {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "cancelled") return "ko";
  if (status === "partial" || status === "waiting_for_confirmation") return "attention";
  return "";
}

export function TaskCard(props: {
  task: TaskView;
  /** Human-readable device name. */
  deviceName?: string | undefined;
  onCancel?: ((taskId: string) => void) | undefined;
}) {
  const { task } = props;
  const isRunning = task.status === "running" || task.status === "pending";

  return (
    <article className="carte">
      <header>
        <strong>{task.title}</strong>
        <span className={`etiquette ${taskTone(task.status)}`}>{STATUS_LABELS[task.status]}</span>
      </header>

      <div className="faible">
        {task.label ?? `${String(task.stepCount)} step(s)`}
        {props.deviceName === undefined ? null : ` · on ${props.deviceName}`}
        {task.startedAt === null ? null : ` · started at ${formatTime(task.startedAt)}`}
        {task.durationMs === null ? null : ` · ${String(Math.round(task.durationMs / 1000))} s`}
      </div>

      {task.originClientDeviceId === null ? null : (
        <div className="faible">Requested from: {task.originClientDeviceId}</div>
      )}

      {task.error === null ? null : (
        <div className="faible" style={{ color: "var(--nexus-danger)" }}>
          {task.error.code} — {task.error.message}
        </div>
      )}

      <div className="jauge">
        <div style={{ width: `${String(task.percent)}%` }} />
      </div>

      {isRunning && props.onCancel !== undefined ? (
        <div className="rangee" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="bouton danger"
            onClick={() => {
              props.onCancel?.(task.id);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ToolCard({ call }: { call: ToolCallView }) {
  return (
    <article className="carte">
      <header>
        <strong>{call.tool}</strong>
        <span
          className={`etiquette ${
            call.status === "succeeded" ? "ok" : call.status === "failed" ? "ko" : ""
          }`}
        >
          {call.status === "running"
            ? "running"
            : call.status === "succeeded"
              ? "completed"
              : "failed"}
        </span>
      </header>
      <div className="faible">{call.summary}</div>
      <div className="faible">risk: {call.riskLevel}</div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirmation request.
 */
export function ConfirmationCard(props: {
  confirmation: ConfirmationView;
  onDecide: (id: string, decision: "approved" | "rejected") => void;
}) {
  const { confirmation } = props;
  const [armed, setArmed] = useState(false);

  const isHighRisk = confirmation.riskLevel === "HIGH" || confirmation.riskLevel === "CRITICAL";

  return (
    <article className={`carte confirmation ${isHighRisk ? "critique" : ""}`}>
      <header>
        <strong>{confirmation.action}</strong>
        <span className={`etiquette ${isHighRisk ? "ko" : "attention"}`}>
          risk {confirmation.riskLevel}
        </span>
      </header>

      <div>{confirmation.description}</div>
      {confirmation.capability === null ? null : (
        <div className="faible">capability: {confirmation.capability}</div>
      )}
      <div className="faible">valid until {formatTime(confirmation.expiresAt)}</div>

      <div className="actions">
        <button
          type="button"
          className="bouton"
          disabled={confirmation.answered}
          onClick={() => {
            props.onDecide(confirmation.id, "rejected");
          }}
        >
          Reject
        </button>

        {isHighRisk && !armed ? (
          <button
            type="button"
            className="bouton approuver"
            disabled={confirmation.answered}
            onClick={() => {
              setArmed(true);
            }}
          >
            Approve…
          </button>
        ) : (
          <button
            type="button"
            className="bouton primaire approuver"
            disabled={confirmation.answered}
            onClick={() => {
              props.onDecide(confirmation.id, "approved");
            }}
          >
            {isHighRisk ? "Confirm approval" : "Approve"}
          </button>
        )}
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ConnectionBanner({ connection, online }: { connection: string; online: boolean }) {
  if (connection === "connected") return null;

  const text = !online
    ? "Offline. NEXUS will resume when network connectivity returns."
    : connection === "reconnecting"
      ? "Reconnecting to NEXUS core…"
      : connection === "connecting" || connection === "authenticating"
        ? "Connecting to NEXUS core…"
        : "Disconnected from NEXUS core.";

  return <div className="banner">{text}</div>;
}

export function ErrorBanner(props: {
  error: { code: string; message: string } | null;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  if (props.error === null) return null;

  return (
    <div className="banner error rangee">
      <span style={{ flex: 1 }}>{props.error.message}</span>
      <button type="button" className="bouton" onClick={props.onRetry}>
        Retry
      </button>
      <button type="button" className="bouton" onClick={props.onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** Local time formatting. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
