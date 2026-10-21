import type { SessionManager } from "./session.js";

/**
 * REST API client calls.
 *
 * All requests route through `SessionManager.authorizedRequest`, which handles
 * transparent token refresh. This file only specifies routes and response types —
 * duplicating token handling here would cause divergence on the first bugfix.
 *
 * What the REST API serves that real-time does not: **history**. The WebSocket
 * channel carries what happens now; the API carries what happened before the
 * application opened.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface ApiDevice {
  id: string;
  name: string;
  type: string;
  platform: string;
  role: string;
  status: string;
  trust: string;
  capabilities: string[];
  grantedPermissions: string[];
  health: {
    activeTasks: number;
    maxConcurrentTasks: number;
    batteryPercent?: number;
    onBattery?: boolean;
  };
  lastSeenAt: string | null;
  authenticated: boolean;
}

export interface ApiTask {
  id: string;
  title: string;
  status: string;
  originClientDeviceId: string;
  steps: {
    id: string;
    description: string;
    status: string;
    selectedDeviceId: string | null;
    riskLevel: string;
    error: { code: string; message: string } | null;
  }[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ApiConversation {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  originClientDeviceId: string | null;
  createdAt: string;
}

export interface ApiMemory {
  id: string;
  content: string;
  layer: string;
  kind: string;
  origin: string;
  importance: number;
  confidence: number;
  tags: string[];
  sensitivity: string;
  sensitiveCategories: string[];
  createdAt: string;
  supersedesId: string | null;
}

export interface ApiMemoryHit {
  id: string;
  content: string;
  kind: string;
  layer: string;
  origin: string;
  sensitivity: string;
  score: number;
}

/** Response from core server to "Remember that..." or "Forget...". */
export interface ApiMemoryCommandResult {
  recognized: boolean;
  kind: "remember" | "forget" | null;
  message: string;
  stored: ApiMemory | null;
  forgotten: ApiMemory[];
  ambiguous: ApiMemory[];
  needsConfirmation: boolean;
}

export interface ApiNotification {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  readAt: string | null;
  createdAt: string;
}

export class ApiClient {
  readonly #session: SessionManager;

  constructor(session: SessionManager) {
    this.#session = session;
  }

  async listDevices(): Promise<ApiDevice[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: "/api/v1/devices?limit=100",
    });
    return this.#unwrapList<ApiDevice>(response.status, response.body);
  }

  async trustDevice(deviceId: string): Promise<ApiDevice> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/devices/${deviceId}/trust`,
    });
    return this.#unwrap<ApiDevice>(response.status, response.body);
  }

  async revokeDevice(deviceId: string): Promise<ApiDevice> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/devices/${deviceId}/revoke`,
    });
    return this.#unwrap<ApiDevice>(response.status, response.body);
  }

  async setDevicePermissions(deviceId: string, permissions: string[]): Promise<ApiDevice> {
    const response = await this.#session.authorizedRequest({
      method: "PATCH",
      path: `/api/v1/devices/${deviceId}/permissions`,
      body: { grantedPermissions: permissions },
    });
    return this.#unwrap<ApiDevice>(response.status, response.body);
  }

  /**
   * Forwards a natural-language instruction to the core server.
   *
   * **This is the only path through which a client triggers an action.** The
   * client neither plans nor executes: it passes the instruction string, and the
   * core orchestrates planner -> authorization -> supervisor -> worker.
   * What this method returns is the **already authorized** plan; subsequent updates
   * arrive via the real-time channel.
   *
   * The request body specifies no worker, capability, or tool. "Open Chrome on my PC"
   * is sent as-is: the core selector picks the machine, and user permissions determine
   * whether execution is authorized. A client assembling its own plan would bypass
   * the planner and duplicate core server responsibilities.
   *
   * **No automatic retry.** A timeout does not clarify whether the core received
   * the instruction; resending "purchase this ticket" on uncertainty risks placing
   * duplicate orders. Callers decide whether to retry after inspecting task state.
   */
  async instruct(input: {
    instruction: string;
    originClientDeviceId: string;
    conversationId?: string;
  }): Promise<ApiTask> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/tasks/instruct",
      body: {
        instruction: input.instruction,
        originClientDeviceId: input.originClientDeviceId,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      },
    });
    return this.#unwrap<ApiTask>(response.status, response.body);
  }

  async getTask(taskId: string): Promise<ApiTask> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/tasks/${taskId}`,
    });
    return this.#unwrap<ApiTask>(response.status, response.body);
  }

  async cancelTask(taskId: string, reason: string): Promise<boolean> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/tasks/${taskId}/cancel`,
      body: { reason },
    });
    return this.#unwrap<{ cancelled: boolean }>(response.status, response.body).cancelled;
  }

  async listNotifications(unreadOnly = false): Promise<ApiNotification[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/notifications?limit=50&unreadOnly=${String(unreadOnly)}`,
    });
    return this.#unwrapList<ApiNotification>(response.status, response.body);
  }

  async markNotificationRead(notificationId: string): Promise<ApiNotification> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/notifications/${notificationId}/read`,
    });
    return this.#unwrap<ApiNotification>(response.status, response.body);
  }

  async listConversations(): Promise<ApiConversation[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: "/api/v1/conversations?limit=50",
    });
    return this.#unwrapList<ApiConversation>(response.status, response.body);
  }

  async listMessages(conversationId: string): Promise<ApiMessage[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/conversations/${conversationId}/messages?limit=100`,
    });
    return this.#unwrapList<ApiMessage>(response.status, response.body);
  }

  /**
   * Creates a task plan.
   *
   * `body` **never** specifies a worker: it declares required capabilities,
   * and the core selects the machine. This is why there is no "run on device X"
   * overload — such an interface would turn the client into an orchestrator
   * and reduce the core to a dumb relay.
   */
  async createTask(body: {
    title: string;
    originClientDeviceId: string;
    conversationId?: string;
    steps: {
      id?: string;
      description: string;
      requiredCapabilities: string[];
      tool: string;
      arguments?: Record<string, unknown>;
      dependsOn: string[];
      riskLevel?: string;
    }[];
  }): Promise<ApiTask> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/tasks",
      body,
    });
    return this.#unwrap<ApiTask>(response.status, response.body);
  }

  /** Capabilities known to the core server across all workers. */
  async listCapabilities(): Promise<{ name: string; description: string; riskLevel: string }[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: "/api/v1/capabilities",
    });
    return this.#unwrapList(response.status, response.body);
  }

  async searchMemory(query: string, limit = 10): Promise<ApiMemoryHit[]> {
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/memory/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`,
    });
    return this.#unwrap<{ hits: ApiMemoryHit[] }>(response.status, response.body).hits;
  }

  /** All memory retained by NEXUS, from newest to oldest. */
  async listMemory(layer?: "LONG_TERM" | "PREFERENCE"): Promise<ApiMemory[]> {
    const suffix = layer === undefined ? "" : `&layer=${layer}`;
    const response = await this.#session.authorizedRequest({
      method: "GET",
      path: `/api/v1/memory?limit=200${suffix}`,
    });
    return this.#unwrapList<ApiMemory>(response.status, response.body);
  }

  /**
   * Stores a memory item.
   *
   * `acknowledgedSensitive` **never defaults to `true`**, here or anywhere:
   * this enforces the sensitivity confirmation policy. The UI passes it only
   * after prompting the user, never before.
   */
  async storeMemory(input: {
    content: string;
    kind?: string;
    layer?: "LONG_TERM" | "PREFERENCE";
    tags?: string[];
    acknowledgedSensitive?: boolean;
  }): Promise<ApiMemory> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/memory",
      body: {
        content: input.content,
        kind: input.kind ?? "SEMANTIC",
        layer: input.layer ?? "LONG_TERM",
        tags: input.tags ?? [],
        acknowledgedSensitive: input.acknowledgedSensitive ?? false,
      },
    });
    return this.#unwrap<ApiMemory>(response.status, response.body);
  }

  async updateMemory(
    memoryId: string,
    patch: {
      content?: string;
      importance?: number;
      tags?: string[];
      layer?: "LONG_TERM" | "PREFERENCE";
      acknowledgedSensitive?: boolean;
    },
  ): Promise<ApiMemory> {
    const response = await this.#session.authorizedRequest({
      method: "PATCH",
      path: `/api/v1/memory/${memoryId}`,
      body: { ...patch, acknowledgedSensitive: patch.acknowledgedSensitive ?? false },
    });
    return this.#unwrap<ApiMemory>(response.status, response.body);
  }

  async forgetMemory(memoryId: string): Promise<ApiMemory[]> {
    const response = await this.#session.authorizedRequest({
      method: "DELETE",
      path: `/api/v1/memory/${memoryId}`,
    });
    return this.#unwrap<{ forgotten: ApiMemory[] }>(response.status, response.body).forgotten;
  }

  /** Clears all memory. `confirmed` is required — this action cannot be undone. */
  async forgetAllMemory(
    confirmed: boolean,
  ): Promise<{ forgotten: ApiMemory[]; needsConfirmation: boolean }> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/memory/forget",
      body: { all: true, confirmed },
    });
    return this.#unwrap(response.status, response.body);
  }

  /** Submits a message to check if it matches "Remember that..." or "Forget...". */
  async memoryCommand(
    text: string,
    options: { acknowledgedSensitive?: boolean; confirmedForgetAll?: boolean } = {},
  ): Promise<ApiMemoryCommandResult> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: "/api/v1/memory/command",
      body: {
        text,
        acknowledgedSensitive: options.acknowledgedSensitive ?? false,
        confirmedForgetAll: options.confirmedForgetAll ?? false,
      },
    });
    return this.#unwrap<ApiMemoryCommandResult>(response.status, response.body);
  }

  async respondToConfirmation(
    confirmationId: string,
    decision: "approved" | "rejected",
  ): Promise<boolean> {
    const response = await this.#session.authorizedRequest({
      method: "POST",
      path: `/api/v1/confirmations/${confirmationId}/respond`,
      body: { decision },
    });
    return this.#unwrap<{ accepted: boolean }>(response.status, response.body).accepted;
  }

  /**
   * Extracts `data`, or throws with the server error message.
   *
   * The server message is safe to display (`userMessage`), containing no
   * internal file paths or stack details. Rewriting it here would discard
   * useful information.
   */
  #unwrap<T>(status: number, body: unknown): T {
    if (status >= 200 && status < 300) return (body as { data: T }).data;
    throw new Error(this.#messageOf(body));
  }

  #unwrapList<T>(status: number, body: unknown): T[] {
    if (status >= 200 && status < 300) return (body as { data: T[] }).data;
    throw new Error(this.#messageOf(body));
  }

  #messageOf(body: unknown): string {
    if (body !== null && typeof body === "object" && "error" in body) {
      const error = body.error;
      if (error !== null && typeof error === "object" && "message" in error) {
        return String(error.message);
      }
    }
    return "The request failed.";
  }
}
