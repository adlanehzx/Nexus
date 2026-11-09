import { z } from "zod";
import { DependencyError, uuidv7 } from "@nexus/shared";
import type { BrowserWorkerClient } from "@nexus/browser-client";
import { engagementTargetUrl, type LinkedInReactionType } from "@nexus/linkedin";

/**
 * Executes reactions and comments on other members' content.
 *
 * LinkedIn's official API does not offer this to personal accounts, so the
 * executor is pluggable: the shipped implementation drives the existing
 * Browser Worker (logged-in persistent profile), and tests plug a fake. There
 * is deliberately no "pretend" implementation — when no executor is reachable
 * the action fails visibly and stays in the queue's history as failed.
 */
export interface EngagementAction {
  userId: string;
  kind: "reaction" | "comment";
  target: string;
  reaction: LinkedInReactionType | null;
  text: string | null;
}

export interface DiscoveredPost {
  target: string;
  summary: string;
}

export interface EngagementExecutor {
  readonly name: string;
  /** Throws a `DependencyError` with a user-facing reason when unusable. */
  assertAvailable(): Promise<void>;
  execute(action: EngagementAction): Promise<{ reference: string }>;
  discover(input: { userId: string; topics: string[]; limit: number }): Promise<DiscoveredPost[]>;
}

const REACTION_LABELS: Record<LinkedInReactionType, string> = {
  LIKE: "Like",
  PRAISE: "Celebrate",
  EMPATHY: "Love",
  INTEREST: "Insightful",
  APPRECIATION: "Support",
  ENTERTAINMENT: "Funny",
};

const discoveredSchema = z
  .array(
    z.object({
      url: z
        .string()
        .regex(/^https:\/\/(www\.)?linkedin\.com\/(feed\/update|posts)\/[^\s]+$/)
        .max(500),
      summary: z.string().max(400).default(""),
    }),
  )
  .max(50);

export class BrowserWorkerEngagementExecutor implements EngagementExecutor {
  readonly name = "browser-worker";
  readonly #client: () => BrowserWorkerClient | undefined;
  readonly #profileId: (userId: string) => string;

  constructor(options: {
    /** Resolved per call: the worker can be configured after boot. */
    client: () => BrowserWorkerClient | undefined;
    /** Persistent, logged-in browser profile of the member. */
    profileId?: (userId: string) => string;
  }) {
    this.#client = options.client;
    this.#profileId = options.profileId ?? ((userId) => `linkedin-${userId}`);
  }

  async assertAvailable(): Promise<void> {
    const client = this.#requireClient();
    let health;
    try {
      health = await client.health();
    } catch (error) {
      throw new DependencyError({
        message: "Browser Worker health check failed",
        userMessage: "The browser worker is unreachable, so LinkedIn engagement cannot run.",
        cause: error,
      });
    }
    if (health.status !== "ok") {
      throw new DependencyError({
        message: `Browser Worker is ${health.status}`,
        userMessage: "The browser worker is degraded, so LinkedIn engagement is paused.",
      });
    }
  }

  async execute(action: EngagementAction): Promise<{ reference: string }> {
    const url = engagementTargetUrl(action.target);
    const instructions =
      action.kind === "reaction"
        ? [
            `Open ${url} (already logged in to LinkedIn).`,
            `Add the "${REACTION_LABELS[action.reaction ?? "LIKE"]}" reaction to the main post on this page.`,
            "If that reaction is already set, do nothing. Do not open any other post, do not follow, do not message.",
            "Report DONE when the reaction is visibly applied, otherwise report the problem.",
          ].join(" ")
        : [
            `Open ${url} (already logged in to LinkedIn).`,
            "Post the following comment on the main post on this page, exactly as written, then stop:",
            JSON.stringify(action.text ?? ""),
            "Do not edit the text. Do not interact with anything else. Report DONE once the comment is visible.",
          ].join(" ");
    const output = await this.#runTask(action.userId, instructions, "interact", 15);
    return { reference: `browser-task:${output.taskId}` };
  }

  async discover(input: {
    userId: string;
    topics: string[];
    limit: number;
  }): Promise<DiscoveredPost[]> {
    const instructions = [
      "Open https://www.linkedin.com/feed/ (already logged in).",
      `Find up to ${String(input.limit)} recent posts by other members about: ${input.topics.join(", ")}.`,
      "Do not react, comment, follow or click any action button: read only.",
      'Answer ONLY with a JSON array like [{"url":"https://www.linkedin.com/feed/update/urn:li:activity:123/","summary":"one sentence"}].',
    ].join(" ");
    const result = await this.#runTask(input.userId, instructions, "read", 20);
    const json = /\[[\s\S]*\]/.exec(result.output ?? "")?.[0];
    const parsed = json === undefined ? undefined : discoveredSchema.safeParse(safeJson(json));
    if (parsed?.success !== true) {
      throw new DependencyError({
        message: "Browser Worker returned an unparseable discovery result",
        userMessage: "The browser worker did not return a usable list of posts.",
      });
    }
    return parsed.data.slice(0, input.limit).map((item) => ({
      target: item.url,
      summary: item.summary,
    }));
  }

  async #runTask(
    userId: string,
    instructions: string,
    intent: "read" | "interact",
    maxSteps: number,
  ): Promise<{ taskId: string; output: string | null }> {
    const client = this.#requireClient();
    const session = await client.createSession({
      ownerId: userId,
      allowedDomains: ["linkedin.com", "www.linkedin.com"],
      profileId: this.#profileId(userId),
      metadata: { purpose: "linkedin-engagement" },
    });
    try {
      const task = await client.runTask({
        taskId: uuidv7(),
        sessionId: session.sessionId,
        instructions,
        intent,
        maxSteps,
        timeoutSeconds: 180,
      });
      const finished = await client.waitForTask(task.taskId, { maxWaitMs: 240_000 });
      if (finished.status !== "succeeded") {
        throw new DependencyError({
          message: `Browser task ended ${finished.status}: ${finished.error?.code ?? ""}`,
          userMessage:
            finished.status === "needs_human"
              ? "LinkedIn asked for a human check (login, CAPTCHA or MFA) in the browser worker."
              : `The browser task did not complete (${finished.status}).`,
        });
      }
      return { taskId: finished.taskId, output: finished.output };
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }

  #requireClient(): BrowserWorkerClient {
    const client = this.#client();
    if (client === undefined) {
      throw new DependencyError({
        message: "No Browser Worker is configured",
        userMessage:
          "No browser worker is configured, so reactions and comments cannot be executed. Configure it, or do the action yourself and mark it done.",
      });
    }
    return client;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
