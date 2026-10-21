import {
  type ActivepiecesFlow,
  type FlowRunResult,
  type FlowTriggerOptions,
  type PieceActionOptions,
  type PieceActionResult,
} from "./types.js";

export class ActivepiecesBridgeClient {
  readonly #baseUrl: string;
  readonly #getApiKey: () => Promise<string>;
  readonly #fetchFn: typeof fetch;

  constructor(options: {
    baseUrl?: string | undefined;
    apiKey: string | (() => Promise<string>);
    fetchFn?: typeof fetch | undefined;
  }) {
    this.#baseUrl = (options.baseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
    this.#getApiKey =
      typeof options.apiKey === "function"
        ? options.apiKey
        : () => Promise.resolve(options.apiKey as string);
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  async #request(
    pathOrUrl: string,
    options: RequestInit & { signal?: AbortSignal | undefined },
  ): Promise<unknown> {
    const apiKey = await this.#getApiKey();
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.#baseUrl}${pathOrUrl}`;

    const headers = new Headers(options.headers);
    if (apiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    headers.set("Accept", "application/json");

    const reqInit: RequestInit = {
      ...options,
      headers,
    };
    if (options.signal) {
      reqInit.signal = options.signal;
    }

    const response = await this.#fetchFn(url, reqInit);

    if (response.status === 204) return null;

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Activepieces error (${response.status}): ${errorBody}`);
    }

    return response.json();
  }

  /**
   * Lists flows configured in the Activepieces instance.
   */
  async listFlows(signal?: AbortSignal): Promise<ActivepiecesFlow[]> {
    const reqOptions: RequestInit & { signal?: AbortSignal | undefined } = { method: "GET" };
    if (signal) reqOptions.signal = signal;

    const data = (await this.#request("/api/v1/flows", reqOptions)) as {
      data?: {
        id: string;
        version?: { displayName: string };
        status: "ENABLED" | "DISABLED";
        updated?: string;
      }[];
    };

    if (!data.data) return [];

    return data.data.map((flow) => ({
      id: flow.id,
      name: flow.version?.displayName ?? flow.id,
      status: flow.status,
      ...(flow.updated !== undefined ? { updatedAt: flow.updated } : {}),
      webhookUrl: `${this.#baseUrl}/api/v1/webhooks/${flow.id}`,
    }));
  }

  /**
   * Triggers an Activepieces flow via webhook URL or flow ID.
   */
  async triggerFlow(options: FlowTriggerOptions, signal?: AbortSignal): Promise<FlowRunResult> {
    const targetUrl = options.webhookUrl ?? `${this.#baseUrl}/api/v1/webhooks/${options.flowId}`;

    const reqOptions: RequestInit & { signal?: AbortSignal | undefined } = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.payload),
    };
    if (signal) reqOptions.signal = signal;

    const res = (await this.#request(targetUrl, reqOptions)) as {
      runId?: string;
      id?: string;
      status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "PAUSED";
      output?: unknown;
    };

    const runId = res.runId ?? res.id ?? `run-${Date.now()}`;
    const flowId = options.flowId ?? "webhook-flow";

    let result: FlowRunResult = {
      runId,
      flowId,
      status: res.status ?? "SUCCEEDED",
      ...(res.output !== undefined ? { output: res.output } : {}),
    };

    if (options.waitForCompletion && result.status === "RUNNING") {
      result = await this.pollRun(runId, 20, 1000, signal);
    }

    return result;
  }

  /**
   * Retrieves status and output of a flow run.
   */
  async getRun(runId: string, signal?: AbortSignal): Promise<FlowRunResult> {
    const reqOptions: RequestInit & { signal?: AbortSignal | undefined } = { method: "GET" };
    if (signal) reqOptions.signal = signal;

    const data = (await this.#request(`/api/v1/flow-runs/${runId}`, reqOptions)) as {
      id: string;
      flowId: string;
      status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PAUSED";
      output?: unknown;
      duration?: number;
      error?: string;
    };

    return {
      runId: data.id,
      flowId: data.flowId,
      status: data.status,
      ...(data.output !== undefined ? { output: data.output } : {}),
      ...(data.duration !== undefined ? { durationMs: data.duration } : {}),
      ...(data.error !== undefined ? { error: data.error } : {}),
    };
  }

  /**
   * Polls run status until completion or timeout.
   */
  async pollRun(
    runId: string,
    maxPolls = 30,
    intervalMs = 1000,
    signal?: AbortSignal,
  ): Promise<FlowRunResult> {
    for (let i = 0; i < maxPolls; i++) {
      if (signal?.aborted) {
        throw new Error("Operation cancelled while waiting for Activepieces run");
      }

      const run = await this.getRun(runId, signal);
      if (run.status !== "RUNNING") {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return this.getRun(runId, signal);
  }

  /**
   * Executes a direct action on a SaaS connector piece (Slack, Notion, Stripe, GitHub, etc.).
   */
  async executePieceAction(
    options: PieceActionOptions,
    signal?: AbortSignal,
  ): Promise<PieceActionResult> {
    const reqOptions: RequestInit & { signal?: AbortSignal | undefined } = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pieceName: options.pieceName,
        actionName: options.actionName,
        input: options.input,
        ...(options.pieceVersion ? { pieceVersion: options.pieceVersion } : {}),
      }),
    };
    if (signal) reqOptions.signal = signal;

    const res = (await this.#request("/api/v1/pieces/actions/execute", reqOptions)) as {
      success?: boolean;
      output?: unknown;
      error?: string;
    };

    return {
      success: res.success ?? true,
      pieceName: options.pieceName,
      actionName: options.actionName,
      output: res.output ?? null,
      ...(res.error !== undefined ? { error: res.error } : {}),
    };
  }
}
