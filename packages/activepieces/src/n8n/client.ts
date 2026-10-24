import { z } from "zod";

export const n8nConfigSchema = z.object({
  baseUrl: z.string().url().default("http://127.0.0.1:5678"),
  apiKeyRef: z.string().regex(/^vault:\/\/nexus\/[a-z0-9_/-]{1,128}$/),
  webhookBaseUrl: z.string().url().optional(),
});
export type N8nConfig = z.infer<typeof n8nConfigSchema>;

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodesCount: number;
  updatedAt?: string | undefined;
}

export interface N8nExecutionResult {
  executionId: string;
  workflowId: string;
  status: "success" | "error" | "running";
  data?: unknown;
  error?: string | undefined;
}

export class N8nClient {
  private readonly config: N8nConfig;
  private readonly resolveSecret: (vaultRef: string) => Promise<string>;

  constructor(config: N8nConfig, resolveSecret: (vaultRef: string) => Promise<string>) {
    this.config = n8nConfigSchema.parse(config);
    this.resolveSecret = resolveSecret;
  }

  async listWorkflows(): Promise<N8nWorkflow[]> {
    const token = await this.resolveSecret(this.config.apiKeyRef);
    const res = await fetch(`${this.config.baseUrl}/api/v1/workflows`, {
      headers: {
        "X-N8N-API-KEY": token,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`n8n API request failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      data?: { id: string; name: string; active: boolean; nodes?: unknown[] }[];
    };
    return (data.data ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      active: w.active,
      nodesCount: w.nodes ? w.nodes.length : 0,
    }));
  }

  async triggerWebhook(
    webhookId: string,
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; output: unknown }> {
    const base = this.config.webhookBaseUrl ?? this.config.baseUrl;
    const res = await fetch(`${base}/webhook/${webhookId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`n8n webhook trigger failed with status ${res.status}`);
    }

    const output: unknown = await res.json().catch(() => ({}));
    return { success: true, output };
  }
}
