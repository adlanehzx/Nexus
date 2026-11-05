import type { AgentEvent, AgentRunStore } from "@nexus/agent-core";
import type { EventRouter } from "@nexus/devices";

/**
 * Forwards a run's progress to its owner's connected clients.
 *
 * The assistant message of a run takes the run's id, which is also the id it gets when
 * persisted: history then replaces the streamed copy instead of duplicating it.
 *
 * Events are sent one at a time, in order: deltas sent concurrently could arrive
 * shuffled. A failed send is dropped rather than failing the run, since progress is only
 * a preview of what the run already persists.
 */
export class AgentRealtimeBridge {
  readonly #router: EventRouter;
  readonly #store: AgentRunStore;
  readonly #owners = new Map<string, Promise<RunOwner | undefined>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { router: EventRouter; store: AgentRunStore }) {
    this.#router = options.router;
    this.#store = options.store;
  }

  readonly handle = (event: AgentEvent): void => {
    const payload = toPayload(event);
    if (payload === undefined) return;
    const finished = event.type === "run.finished";
    this.#queue = this.#queue
      .then(async () => {
        const owner = await this.#owner(event.runId);
        if (owner === undefined) return;
        const data =
          "conversationId" in payload
            ? { ...payload, conversationId: owner.conversationId }
            : payload;
        await this.#router.emit({
          type: payload.type,
          userId: owner.userId,
          correlationId: owner.correlationId,
          payload: data,
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (finished) this.#owners.delete(event.runId);
      });
  };

  /** Resolves once everything received so far has been sent. For tests and shutdown. */
  flushed(): Promise<unknown> {
    return this.#queue;
  }

  #owner(runId: string): Promise<RunOwner | undefined> {
    let owner = this.#owners.get(runId);
    if (owner === undefined) {
      owner = this.#store.load(runId).then((state) =>
        state === undefined
          ? undefined
          : {
              userId: state.record.userId,
              conversationId: state.record.conversationId,
              correlationId: state.record.correlationId,
            },
      );
      this.#owners.set(runId, owner);
    }
    return owner;
  }
}

interface RunOwner {
  userId: string;
  conversationId: string;
  correlationId: string;
}

function toPayload(event: AgentEvent) {
  switch (event.type) {
    case "agent.delta":
      return {
        type: "message.delta" as const,
        conversationId: "",
        messageId: event.runId,
        delta: event.delta,
        done: false,
      };
    case "run.finished":
      return {
        type: "message.delta" as const,
        conversationId: "",
        messageId: event.runId,
        delta: "",
        done: true,
      };
    case "tool.started":
      return {
        type: "tool.started" as const,
        runId: event.runId,
        callId: event.toolCallId,
        tool: event.name,
        // The arguments are not shown: they can hold personal data, and a lock screen
        // or a shared display is one notification away from this frame.
        summary: event.name,
        riskLevel: event.riskLevel,
      };
    case "tool.progress":
      return {
        type: "tool.progress" as const,
        runId: event.runId,
        callId: event.toolCallId,
        percent: event.pct === undefined ? null : Math.round(event.pct),
        label: event.label ?? null,
      };
    case "tool.completed":
      return {
        type: "tool.completed" as const,
        runId: event.runId,
        callId: event.toolCallId,
        tool: event.name,
        ok: event.ok,
        summary: event.summary,
        durationMs: event.durationMs,
      };
    default:
      return undefined;
  }
}
