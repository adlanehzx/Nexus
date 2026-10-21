import { SERVER_TO_CLIENT, type ServerToClientType } from "@nexus/protocol";

/**
 * State presented by the client.
 *
 * A **pure reducer**: frame in, new state out. No requests, no side effects,
 * no implicit timers.
 *
 *  1. Completely testable without simulators or running servers;
 *  2. Replaying event queues after reconnection produces identical state to continuous connection;
 *  3. Unknown frames leave state unchanged rather than throwing.
 *
 * The store describes what the core server reported without making decisions.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_confirmation"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  /** Overall plan progress, from 0 to 100. */
  percent: number;
  /** Human-readable description of current step. */
  label: string | null;
  /** Device executing the current step. */
  workerDeviceId: string | null;
  /** Device where request originated. Preserved end-to-end. */
  originClientDeviceId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: { code: string; message: string } | null;
  stepCount: number;
}

export interface ToolCallView {
  callId: string;
  runId: string;
  tool: string;
  /** Readable summary. Raw tool arguments are not passed to store. */
  summary: string;
  riskLevel: string;
  status: "running" | "succeeded" | "failed";
  percent: number | null;
  label: string | null;
  durationMs: number | null;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** True while response is streaming. */
  streaming: boolean;
  createdAt: string;
  originClientDeviceId: string | null;
}

export interface DeviceView {
  id: string;
  name: string;
  role: string;
  status: string;
  capabilities: string[];
  lastSeenAt: string | null;
}

export interface NotificationView {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  readAt: string | null;
  createdAt: string;
}

export interface ConfirmationView {
  id: string;
  taskId: string | null;
  capability: string | null;
  action: string;
  description: string;
  riskLevel: string;
  expiresAt: string;
  /** Set to `true` when user has decided — prevents duplicate actions. */
  answered: boolean;
}

export type ConnectionState =
  "offline" | "connecting" | "authenticating" | "connected" | "reconnecting";

export interface ClientState {
  connection: ConnectionState;
  /** Device network connectivity. Distinct from core server connection. */
  online: boolean;
  messages: MessageView[];
  tasks: TaskView[];
  toolCalls: ToolCallView[];
  devices: DeviceView[];
  notifications: NotificationView[];
  confirmations: ConfirmationView[];
  /** Last displayable error. Cleared by UI after acknowledgement. */
  lastError: { code: string; message: string; at: string } | null;
}

export const initialState: ClientState = {
  connection: "offline",
  online: true,
  messages: [],
  tasks: [],
  toolCalls: [],
  devices: [],
  notifications: [],
  confirmations: [],
  lastError: null,
};

export type ClientAction =
  | { kind: "connection"; state: ConnectionState }
  | { kind: "network"; online: boolean }
  | { kind: "server"; type: ServerToClientType; payload: Record<string, unknown> }
  | { kind: "localMessage"; message: MessageView }
  | { kind: "devices"; devices: DeviceView[] }
  /**
   * Task state re-queried from core server.
   *
   * Used for resync after reconnection: real-time channel does not replay events.
   */
  | {
      kind: "taskSync";
      task: {
        id: string;
        title: string;
        status: string;
        startedAt: string | null;
        completedAt: string | null;
        stepCount: number;
        originClientDeviceId: string | null;
        error: { code: string; message: string } | null;
      };
    }
  | { kind: "confirmationAnswered"; confirmationId: string }
  | { kind: "notificationRead"; notificationId: string; at: string }
  | { kind: "error"; code: string; message: string; at: string }
  | { kind: "clearError" }
  | { kind: "reset" };

/**
 * Applies an action.
 *
 * Pure reducer: every branch returns a new object.
 */
export function reduce(state: ClientState, action: ClientAction): ClientState {
  switch (action.kind) {
    case "connection":
      return { ...state, connection: action.state };

    case "network":
      return {
        ...state,
        online: action.online,
        // Losing network does not immediately close WebSocket connection, but
        // UI reflects offline state immediately so user is informed.
        connection: action.online ? state.connection : "offline",
      };

    case "localMessage":
      return { ...state, messages: [...state.messages, action.message] };

    case "devices":
      return { ...state, devices: action.devices };

    case "taskSync": {
      const sync = action.task;

      // Status originates from core server. Keep existing status if unknown.
      const status = isTaskStatus(sync.status) ? sync.status : undefined;

      return upsertTask(state, sync.id, (task) => ({
        ...task,
        title: sync.title.length > 0 ? sync.title : task.title,
        status: status ?? task.status,
        // Completed task is set to 100%.
        percent: status !== undefined && !isActive(status) ? 100 : task.percent,
        label: status !== undefined && !isActive(status) ? null : task.label,
        stepCount: sync.stepCount > 0 ? sync.stepCount : task.stepCount,
        originClientDeviceId: sync.originClientDeviceId ?? task.originClientDeviceId,
        startedAt: sync.startedAt ?? task.startedAt,
        completedAt: sync.completedAt ?? task.completedAt,
        error: sync.error ?? task.error,
      }));
    }

    case "confirmationAnswered":
      return {
        ...state,
        confirmations: state.confirmations.map((confirmation) =>
          confirmation.id === action.confirmationId
            ? { ...confirmation, answered: true }
            : confirmation,
        ),
      };

    case "notificationRead":
      return {
        ...state,
        notifications: state.notifications.map((notification) =>
          notification.id === action.notificationId
            ? { ...notification, readAt: notification.readAt ?? action.at }
            : notification,
        ),
      };

    case "error":
      return {
        ...state,
        lastError: { code: action.code, message: action.message, at: action.at },
      };

    case "clearError":
      return { ...state, lastError: null };

    case "reset":
      return { ...initialState, online: state.online };

    case "server":
      return applyServerMessage(state, action.type, action.payload);
  }
}

function applyServerMessage(
  state: ClientState,
  type: ServerToClientType,
  payload: Record<string, unknown>,
): ClientState {
  switch (type) {
    // ── Conversation ────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.messageDelta: {
      const messageId = str(payload, "messageId");
      const delta = str(payload, "delta");
      const done = bool(payload, "done");

      const existing = state.messages.find((message) => message.id === messageId);

      // First delta creates message.
      if (existing === undefined) {
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              id: messageId,
              role: "assistant",
              content: delta,
              streaming: !done,
              createdAt: nowFrom(payload),
              originClientDeviceId: asStringOrNull(payload.originClientDeviceId),
            },
          ],
        };
      }

      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === messageId
            ? { ...message, content: message.content + delta, streaming: !done }
            : message,
        ),
      };
    }

    // ── Tasks ───────────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.taskCreated:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        title: str(payload, "title", "Task"),
        stepCount: num(payload, "stepCount", 1),
        status: "pending",
        originClientDeviceId: asStringOrNull(payload.originClientDeviceId),
        startedAt: nowFrom(payload),
      }));

    case SERVER_TO_CLIENT.taskProgress:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: "running",
        percent: num(payload, "percent", task.percent),
        label: asStringOrNull(payload.label) ?? task.label,
        // Do not overwrite known worker with null on intermediate progress frames.
        workerDeviceId: asStringOrNull(payload.deviceId) ?? task.workerDeviceId,
      }));

    case SERVER_TO_CLIENT.taskCompleted:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: payload.status === "partial" ? "partial" : "succeeded",
        percent: 100,
        durationMs: num(payload, "durationMs", 0),
        completedAt: nowFrom(payload),
        label: null,
      }));

    case SERVER_TO_CLIENT.taskCancelled:
      // Cancelled task is completed, not failed.
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: "cancelled",
        completedAt: nowFrom(payload),
        label: str(payload, "reason", "cancelled"),
      }));

    case SERVER_TO_CLIENT.taskFailed:
      return upsertTask(state, str(payload, "taskId"), (task) => ({
        ...task,
        status: "failed",
        completedAt: nowFrom(payload),
        error: {
          code: str(payload, "code", "UNKNOWN"),
          message: str(payload, "message", "The task failed."),
        },
      }));

    // ── Tools ───────────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.toolStarted:
      return upsertToolCall(state, str(payload, "callId"), (call) => ({
        ...call,
        runId: str(payload, "runId"),
        tool: str(payload, "tool"),
        summary: str(payload, "summary"),
        riskLevel: str(payload, "riskLevel", "MEDIUM"),
        status: "running",
      }));

    case SERVER_TO_CLIENT.toolProgress:
      return upsertToolCall(state, str(payload, "callId"), (call) => ({
        ...call,
        percent: asNumberOrNull(payload.percent) ?? call.percent,
        label: asStringOrNull(payload.label) ?? call.label,
      }));

    case SERVER_TO_CLIENT.toolCompleted:
      return upsertToolCall(state, str(payload, "callId"), (call) => ({
        ...call,
        status: bool(payload, "ok") ? "succeeded" : "failed",
        summary: str(payload, "summary", call.summary),
        durationMs: num(payload, "durationMs", 0),
        percent: 100,
      }));

    // ── Confirmations ───────────────────────────────────────────────────
    case SERVER_TO_CLIENT.confirmationRequired: {
      const id = str(payload, "confirmationId");
      // Deduplicate confirmation cards.
      if (state.confirmations.some((confirmation) => confirmation.id === id)) return state;

      return {
        ...state,
        confirmations: [
          ...state.confirmations,
          {
            id,
            taskId: asStringOrNull(payload.taskId),
            capability: asStringOrNull(payload.capability),
            action: str(payload, "action"),
            description: str(payload, "description"),
            riskLevel: str(payload, "riskLevel", "MEDIUM"),
            expiresAt: str(payload, "expiresAt"),
            answered: false,
          },
        ],
      };
    }

    // ── Devices ─────────────────────────────────────────────────────────
    case SERVER_TO_CLIENT.deviceUpdated: {
      const id = str(payload, "deviceId");
      // Partial updates only patch present fields.
      const name = asStringOrNull(payload.deviceName) ?? asStringOrNull(payload.name);
      const status = asStringOrNull(payload.status);
      const role = asStringOrNull(payload.role);
      const capabilities = strings(payload, "capabilities");

      const patch: Partial<DeviceView> = {
        ...(name === null ? {} : { name }),
        ...(status === null ? {} : { status }),
        ...(role === null ? {} : { role }),
        ...(capabilities === undefined ? {} : { capabilities }),
      };

      const existing = state.devices.find((device) => device.id === id);
      if (existing === undefined) {
        return {
          ...state,
          devices: [
            ...state.devices,
            {
              id,
              name: patch.name ?? id,
              role: patch.role ?? "WORKER",
              status: patch.status ?? "OFFLINE",
              capabilities: patch.capabilities ?? [],
              lastSeenAt: nowFrom(payload),
            },
          ],
        };
      }

      return {
        ...state,
        devices: state.devices.map((device) =>
          device.id === id ? { ...device, ...patch, lastSeenAt: nowFrom(payload) } : device,
        ),
      };
    }

    // ── Notifications ───────────────────────────────────────────────────
    case SERVER_TO_CLIENT.notificationCreated: {
      const id = str(payload, "notificationId");
      if (state.notifications.some((notification) => notification.id === id)) return state;

      return {
        ...state,
        notifications: [
          {
            id,
            title: str(payload, "title"),
            body: str(payload, "body"),
            severity: asSeverity(payload.severity),
            readAt: null,
            createdAt: nowFrom(payload),
          },
          ...state.notifications,
        ],
      };
    }

    default:
      // Known protocol frames without store impact (e.g. ack) or unknown future frames.
      return state;
  }
}

/** Creates task if absent, updates otherwise. */
function upsertTask(
  state: ClientState,
  taskId: string,
  patch: (task: TaskView) => TaskView,
): ClientState {
  const existing = state.tasks.find((task) => task.id === taskId);

  // A task can arrive through progress frames if client was offline when started.
  const base: TaskView = existing ?? {
    id: taskId,
    title: "Task",
    status: "pending",
    percent: 0,
    label: null,
    workerDeviceId: null,
    originClientDeviceId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    stepCount: 1,
  };

  const updated = patch(base);

  return {
    ...state,
    tasks:
      existing === undefined
        ? [updated, ...state.tasks]
        : state.tasks.map((task) => (task.id === taskId ? updated : task)),
  };
}

function upsertToolCall(
  state: ClientState,
  callId: string,
  patch: (call: ToolCallView) => ToolCallView,
): ClientState {
  const existing = state.toolCalls.find((call) => call.callId === callId);

  const base: ToolCallView = existing ?? {
    callId,
    runId: "",
    tool: "",
    summary: "",
    riskLevel: "MEDIUM",
    status: "running",
    percent: null,
    label: null,
    durationMs: null,
  };

  const updated = patch(base);

  return {
    ...state,
    toolCalls:
      existing === undefined
        ? [...state.toolCalls, updated]
        : state.toolCalls.map((call) => (call.callId === callId ? updated : call)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selectors
// ─────────────────────────────────────────────────────────────────────────────

/** Active tasks (running, pending, waiting_for_confirmation). */
export function activeTasks(state: ClientState): TaskView[] {
  return state.tasks.filter(
    (task) =>
      task.status === "running" ||
      task.status === "pending" ||
      task.status === "waiting_for_confirmation",
  );
}

export function finishedTasks(state: ClientState): TaskView[] {
  return state.tasks.filter(
    (task) =>
      task.status === "succeeded" ||
      task.status === "partial" ||
      task.status === "failed" ||
      task.status === "cancelled",
  );
}

export function pendingConfirmations(state: ClientState): ConfirmationView[] {
  return state.confirmations.filter((confirmation) => !confirmation.answered);
}

export function unreadNotifications(state: ClientState): NotificationView[] {
  return state.notifications.filter((notification) => notification.readAt === null);
}

/** Whether application can interact (network online AND connected to core). */
export function canInteract(state: ClientState): boolean {
  return state.online && state.connection === "connected";
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads string from untyped payload with fallback.
 */
function str(payload: Record<string, unknown>, key: string, fallback = ""): string {
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

function num(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function strings(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asSeverity(value: unknown): "info" | "warning" | "error" {
  return value === "warning" || value === "error" ? value : "info";
}

/**
 * Extracts payload timestamp (server time).
 */
function nowFrom(payload: Record<string, unknown>): string {
  return str(payload, "at") || str(payload, "ts") || new Date(0).toISOString();
}

/** Checks if value matches TaskStatus. */
function isTaskStatus(value: string): value is TaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "waiting_for_confirmation" ||
    value === "succeeded" ||
    value === "partial" ||
    value === "failed" ||
    value === "cancelled"
  );
}

/** Checks if status is an active (non-terminal) state. */
function isActive(status: TaskStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting_for_confirmation";
}
