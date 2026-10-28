import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";

export interface LocalLlmConfig {
  runtime: "disabled" | "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
}

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(1_000_000),
});

export const localLlmInputSchema = z.object({
  messages: z.array(messageSchema).min(1).max(512),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        description: z.string().max(8_000),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(128)
    .optional(),
  maxTokens: z.number().int().min(1).max(131_072).optional(),
});

export interface LocalLlmOutput {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: { id: string; name: string; arguments: unknown }[];
}

interface ChatPayload {
  model?: string;
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
  };
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
    };
  }[];
  prompt_eval_count?: number;
  eval_count?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Runs inference against a model server reachable only from the worker machine. */
export function createLocalLlmCapability(
  config: LocalLlmConfig,
): LocalCapability<z.infer<typeof localLlmInputSchema>, LocalLlmOutput> | null {
  if (config.runtime === "disabled" || config.model.length === 0) return null;

  return {
    name: "llm.inference",
    description:
      "Runs private model inference on this device without sending prompts to a cloud API.",
    version: "1",
    inputSchema: localLlmInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "object" } },
        tools: { type: "array", items: { type: "object" } },
        maxTokens: { type: "integer", minimum: 1 },
      },
      required: ["messages"],
    },
    riskLevel: "SAFE",
    sensitiveResult: true,
    metadata: { runtime: config.runtime, model: config.model, privacy: "local_only" },
    probe: async () => probeLocalLlm(config),
    execute: async (input, context) => {
      const endpoint =
        config.runtime === "ollama"
          ? `${config.baseUrl}/api/chat`
          : `${config.baseUrl}/v1/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          messages: input.messages,
          ...(input.tools === undefined
            ? {}
            : {
                tools: input.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }),
          ...(input.maxTokens === undefined
            ? {}
            : config.runtime === "ollama"
              ? { options: { num_predict: input.maxTokens } }
              : { max_tokens: input.maxTokens }),
        }),
        signal: context.signal,
      });
      if (!response.ok) throw new Error(`Local model returned HTTP ${String(response.status)}.`);
      const payload = (await response.json()) as ChatPayload;
      const message = config.runtime === "ollama" ? payload.message : payload.choices?.[0]?.message;
      if (message === undefined) throw new Error("Local model returned an invalid response.");
      return {
        text: typeof message.content === "string" ? message.content : "",
        model: payload.model ?? config.model,
        inputTokens: payload.prompt_eval_count ?? payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.eval_count ?? payload.usage?.completion_tokens ?? 0,
        toolCalls: (message.tool_calls ?? []).flatMap((call, index) => {
          const name = call.function?.name;
          if (typeof name !== "string" || name.length === 0) return [];
          return [
            {
              id: call.id ?? `device-tool-${String(index)}`,
              name,
              arguments: parseArguments(call.function?.arguments),
            },
          ];
        }),
      };
    },
  };
}

async function probeLocalLlm(config: LocalLlmConfig): Promise<boolean> {
  const endpoint =
    config.runtime === "ollama" ? `${config.baseUrl}/api/tags` : `${config.baseUrl}/v1/models`;
  try {
    const response = await fetch(endpoint, {
      headers: config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
