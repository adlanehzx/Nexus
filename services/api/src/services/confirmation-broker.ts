import type { ConfirmationGate } from "@nexus/devices";
import type { ConfirmationService } from "@nexus/tools";
import type { NotificationService } from "./notification-service.js";

/**
 * Bridge between the task coordinator and human decision-making.
 *
 * `TaskCoordinator` expects a `ConfirmationGate`: it asks a question and
 * awaits a verdict. `ConfirmationService` handles creating and resolving requests,
 * but **never blocks** — which is its core strength, as an agent run can
 * wait ten minutes without tying up server processes.
 *
 * This broker reconciles the two: it creates the request, keeps the promise
 * pending, and resolves it when the user responds from **any of their
 * devices**. This last point is essential: a confirmation requested
 * while active on iPhone can be approved from a laptop, because
 * the request lives centrally rather than within the displaying client.
 *
 * An unanswered request expires. Expiration counts as a **rejection**: silence
 * must never imply consent for an action touching files or finances.
 */

type Decision = "approved" | "rejected" | "expired";

interface Pending {
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  userId: string;
}

export interface ConfirmationBrokerOptions {
  confirmations: ConfirmationService;
  notifications?: NotificationService | undefined;
  dashboardBaseUrl?: string | undefined;
  now?: () => Date;
  /** Injectable helpers to test expiration without real delays. */
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class ConfirmationBroker implements ConfirmationGate {
  readonly #confirmations: ConfirmationService;
  readonly #notifications: NotificationService | undefined;
  readonly #dashboardBaseUrl: string;
  readonly #now: () => Date;
  readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  readonly #pending = new Map<string, Pending>();

  constructor(options: ConfirmationBrokerOptions) {
    this.#confirmations = options.confirmations;
    this.#notifications = options.notifications;
    this.#dashboardBaseUrl = options.dashboardBaseUrl ?? "http://localhost:3000";
    this.#now = options.now ?? (() => new Date());
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      });
  }

  /** Pending requests for a user — diagnostics and testing. */
  pendingIds(userId: string): string[] {
    return [...this.#pending.entries()]
      .filter(([, pending]) => pending.userId === userId)
      .map(([id]) => id);
  }

  /**
   * Requests confirmation and awaits the response.
   *
   * The identifier matches the one emitted by the coordinator in its
   * `confirmation.required` event: clients have received it, and will send it
   * back. Creating a second identifier here would introduce desynchronization.
   */
  request(input: Parameters<ConfirmationGate["request"]>[0]): Promise<Decision> {
    const ttlMs = Math.max(0, input.expiresAt.getTime() - this.#now().getTime());

    return new Promise<Decision>((resolve) => {
      let settled = false;
      const settle = (decision: Decision) => {
        if (settled) return;
        settled = true;

        const pending = this.#pending.get(input.confirmationId);
        if (pending?.timer !== undefined) this.#clearTimer(pending.timer);
        this.#pending.delete(input.confirmationId);

        resolve(decision);
      };

      // Silence means rejection, never approval.
      const timer = this.#setTimer(() => {
        settle("expired");
      }, ttlMs);

      this.#pending.set(input.confirmationId, {
        resolve: settle,
        timer,
        userId: input.userId,
      });

      if (this.#notifications) {
        const desc = input.description ?? "sensitive action";
        const confirmUrl = `${this.#dashboardBaseUrl.replace(/\/$/, "")}/dashboard?tab=confirmations&id=${encodeURIComponent(input.confirmationId)}`;
        void this.#notifications
          .create({
            userId: input.userId,
            title: `Confirmation required: ${desc.slice(0, 45)}`,
            body: `Agent requests confirmation: ${desc}`,
            severity: "warning",
            url: confirmUrl,
            actionTitle: "Confirm action",
            tags: ["confirmation", "security"],
            groupKey: `confirmation-${input.confirmationId}`,
          })
          .catch(() => {
            // Ignored: notification failure does not block confirmation flow
          });
      }
    });
  }

  /**
   * Records user response.
   *
   * Returns `false` if no pending request matches this identifier: standard
   * behavior when two clients respond almost simultaneously, or when the request
   * expired between display and interaction. This is not an error, and treating it
   * as such would show a failure message to the second client when the action
   * succeeded.
   */
  respond(confirmationId: string, decision: "approved" | "rejected", userId: string): boolean {
    const pending = this.#pending.get(confirmationId);

    // **The request belongs to someone.** The broker already knew its
    // owner; failing to check it would allow any authenticated account
    // to approve someone else's action, provided they know the
    // identifier — which travels to all clients of the victim.
    //
    // Rejection is indistinguishable from an absent request: distinguishing
    // them would allow probing for others' pending confirmations.
    if (pending?.userId !== userId) return false;

    pending.resolve(decision);
    return true;
  }

  /**
   * Records the decision **and** logs it in the confirmation service.
   *
   * The two records serve distinct purposes: the service maintains durable
   * history — who approved what, and when — while this broker only
   * manages in-flight promises.
   */
  async respondAndRecord(
    confirmationId: string,
    decision: "approved" | "rejected",
    userId: string,
  ): Promise<boolean> {
    const known = await this.#confirmations.get(confirmationId);

    // Ownership verified **before** writing audit log: recording an intruder's
    // decision in a victim's history would pollute the audit trail even if
    // the action does not execute.
    if (known !== undefined && known.userId !== userId) return false;

    // A request emitted by the coordinator initially lives only in the
    // broker; it arbitrates ownership in this case, and is aware of it.
    if (known === undefined && this.#pending.get(confirmationId)?.userId !== userId) return false;

    if (known !== undefined) await this.#confirmations.resolve(confirmationId, decision);

    return this.respond(confirmationId, decision, userId);
  }

  /** Rejects all pending requests — server shutdown, or revocation. */
  rejectAll(): number {
    const count = this.#pending.size;
    for (const [id] of [...this.#pending]) {
      this.#pending.get(id)?.resolve("rejected");
    }
    return count;
  }
}
