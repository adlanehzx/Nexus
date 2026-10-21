/**
 * Read-only ports for data layers not owned by this package.
 *
 * Conversation history, device inventory, and task execution history
 * belong to their respective domains. `@nexus/memory` accesses them
 * via read-only ports when assembling prompt contexts.
 */

export interface ConversationTurn {
  role: string;
  content: string;
  createdAt: Date;
}

export interface ConversationHistoryPort {
  /**
   * Recent turns from a conversation.
   *
   * `limit` caps query at the source to prevent loading unbounded history.
   */
  recentTurns(input: {
    userId: string;
    conversationId: string;
    limit: number;
  }): Promise<ConversationTurn[]>;
}

export interface DeviceSummary {
  id: string;
  name: string;
  role: string;
  status: string;
  capabilities: readonly string[];
}

export interface DeviceContextPort {
  /**
   * User fleet summary.
   *
   * Provides available devices and capabilities so models can plan feasible steps.
   */
  devicesFor(userId: string): Promise<DeviceSummary[]>;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  completedAt: Date | null;
  /** Executing device name, when known. */
  deviceName: string | null;
}

export interface TaskHistoryPort {
  /** Recent tasks for the user (both active and completed). */
  recentTasks(input: { userId: string; limit: number }): Promise<TaskSummary[]>;
}
