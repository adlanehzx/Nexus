import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AnthropicProvider,
  FallbackProvider,
  LLMProviderError,
  OpenAICompatibleProvider,
  textOf,
  toolInputJsonSchema,
  type GenerateRequest,
  type GenerateResponse,
  type LLMProvider,
  type ProviderCapabilities,
  type StreamChunk,
} from "@nexus/llm";
import type { DeviceSelector, WorkerTransport } from "@nexus/devices";
import type {
  LlmEngineConfig,
  RuntimeConfigurationStore,
  SecretVault,
} from "./runtime-configuration.js";

const PAID_PRESETS: Record<
  Exclude<
    Extract<LlmEngineConfig, { kind: "paid-api" }>["provider"],
    "anthropic" | "openai-compatible"
  >,
  { baseUrl: string; chatCompletionsPath?: string }
> = {
  openai: { baseUrl: "https://api.openai.com" },
  "google-gemini": {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatCompletionsPath: "/chat/completions",
  },
  openrouter: { baseUrl: "https://openrouter.ai/api" },
  mistral: { baseUrl: "https://api.mistral.ai" },
  deepseek: { baseUrl: "https://api.deepseek.com" },
};

export interface DeviceInferencePort {
  selector: Pick<DeviceSelector, "select">;
  transport: Pick<WorkerTransport, "dispatch" | "cancel">;
}

export interface LlmRuntimeStatus {
  enabled: boolean;
  preferLocal: boolean;
  engines: {
    id: string;
    label: string;
    kind: LlmEngineConfig["kind"];
    provider: string;
    model: string;
    enabled: boolean;
    priority: number;
    credentialConfigured: boolean;
  }[];
}

/** Hot-reloadable router for paid APIs and private models hosted on paired workers. */
export class UnifiedLlmRuntimeProvider implements LLMProvider {
  readonly id = "nexus-unified-runtime";
  readonly model = "auto";
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    vision: true,
    structuredOutput: true,
    maxContextTokens: 10_000_000,
  };

  readonly #runtime: RuntimeConfigurationStore;
  readonly #vault: SecretVault;
  readonly #baseProviders: readonly LLMProvider[];
  readonly #finalProviders: readonly LLMProvider[];
  readonly #devices: DeviceInferencePort;

  constructor(options: {
    runtime: RuntimeConfigurationStore;
    vault: SecretVault;
    baseProviders: readonly LLMProvider[];
    finalProviders?: readonly LLMProvider[];
    devices: DeviceInferencePort;
  }) {
    this.#runtime = options.runtime;
    this.#vault = options.vault;
    this.#baseProviders = options.baseProviders;
    this.#finalProviders = options.finalProviders ?? [];
    this.#devices = options.devices;
  }

  async status(): Promise<LlmRuntimeStatus> {
    const config = await this.#runtime.loadLlmRouting();
    const engines = await Promise.all(
      config.engines.map(async (engine) => ({
        id: engine.id,
        label: engine.label,
        kind: engine.kind,
        provider: engine.kind === "device" ? engine.runtime : engine.provider,
        model: engine.model,
        enabled: engine.enabled,
        priority: engine.priority,
        credentialConfigured:
          engine.kind === "device" ? true : (await this.#vault.get(engine.apiKeyRef)) !== undefined,
      })),
    );
    return { enabled: config.enabled, preferLocal: config.preferLocal, engines };
  }

  async testEngine(
    engineId: string,
    userId: string,
  ): Promise<{ provider: string; model: string; text: string }> {
    const providers = await this.#configuredProviders({
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply exactly: NEXUS engine ready" }] },
      ],
      maxTokens: 32,
      routingContext: { userId },
    });
    const selected = providers.find((entry) => entry.id === engineId);
    if (selected === undefined) throw unavailable(`LLM engine ${engineId} is not ready.`);
    const response = await selected.provider.generate({
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply exactly: NEXUS engine ready" }] },
      ],
      maxTokens: 32,
      routingContext: { userId },
    });
    return {
      provider: selected.provider.id,
      model: response.model,
      text: textOf(response.content),
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    try {
      return await this.#generateOnDevice(request);
    } catch (cause) {
      if (cause instanceof LLMProviderError) throw cause;
      throw new LLMProviderError(this.id, {
        message: "Private device inference is unavailable.",
        retryable: true,
        cause,
      });
    }
  }

  async #generateOnDevice(request: GenerateRequest): Promise<GenerateResponse> {
    return (await this.#router(request)).generate(request);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    yield* (await this.#router(request)).stream(request);
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    return (await this.#router(request)).structuredOutput(request, schema);
  }

  async countTokens(
    request: Pick<GenerateRequest, "messages" | "system" | "tools">,
  ): Promise<number> {
    return (
      this.#baseProviders[0]?.countTokens(request) ??
      Promise.resolve(Math.ceil(JSON.stringify(request).length / 4))
    );
  }

  async #router(request: GenerateRequest): Promise<FallbackProvider> {
    const configured = await this.#configuredProviders(request);
    const providers = [
      ...configured.map((entry) => entry.provider),
      ...this.#baseProviders,
      ...this.#finalProviders,
    ];
    if (providers.length === 0) throw unavailable("No LLM engine is configured.");
    return new FallbackProvider(providers);
  }

  async #configuredProviders(
    request: GenerateRequest,
  ): Promise<{ id: string; priority: number; provider: LLMProvider; local: boolean }[]> {
    const config = await this.#runtime.loadLlmRouting();
    if (!config.enabled) return [];
    const providers: { id: string; priority: number; provider: LLMProvider; local: boolean }[] = [];
    for (const engine of config.engines) {
      if (!engine.enabled) continue;
      if (engine.kind === "device") {
        if (request.routingContext?.userId === undefined) continue;
        providers.push({
          id: engine.id,
          priority: engine.priority,
          local: true,
          provider: new DeviceLlmProvider(engine, this.#devices),
        });
        continue;
      }
      const key = await this.#vault.get(engine.apiKeyRef);
      if (key === undefined) continue;
      providers.push({
        id: engine.id,
        priority: engine.priority,
        local: false,
        provider: providerForPaidEngine(engine, key),
      });
    }
    providers.sort((left, right) => {
      if (config.preferLocal && left.local !== right.local) return left.local ? -1 : 1;
      return left.priority - right.priority || left.id.localeCompare(right.id);
    });
    return providers;
  }
}

class DeviceLlmProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  readonly #engine: Extract<LlmEngineConfig, { kind: "device" }>;
  readonly #devices: DeviceInferencePort;

  constructor(engine: Extract<LlmEngineConfig, { kind: "device" }>, devices: DeviceInferencePort) {
    this.id = engine.id;
    this.model = engine.model;
    this.#engine = engine;
    this.#devices = devices;
    this.capabilities = {
      tools: true,
      vision: false,
      structuredOutput: true,
      maxContextTokens: engine.maxContextTokens,
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const userId = request.routingContext?.userId;
    if (userId === undefined) throw unavailable("Device inference requires an authenticated user.");
    const selection = await this.#devices.selector.select({
      userId,
      requiredCapabilities: ["llm.inference"],
      ...(this.#engine.preferredDeviceId === null
        ? {}
        : { preferredDeviceId: this.#engine.preferredDeviceId }),
      ...(this.#engine.minimumGpuVramMb === 0
        ? {}
        : { constraints: { minGpuVramMb: this.#engine.minimumGpuVramMb } }),
    });
    const result = await this.#devices.transport.dispatch({
      deviceId: selection.device.id,
      taskId: request.routingContext?.runId ?? `llm-${randomUUID()}`,
      stepId: `inference-${randomUUID()}`,
      tool: "device.llm.inference",
      capability: "llm.inference",
      arguments: {
        messages: [
          ...(request.system === undefined ? [] : [{ role: "system", content: request.system }]),
          ...request.messages.map((message) => ({
            role: message.role,
            content: textOf(message.content),
          })),
        ],
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      },
      timeoutMs: 300_000,
      signal: request.signal ?? new AbortController().signal,
      onProgress: () => undefined,
    });
    if (!result.ok) {
      throw new LLMProviderError(this.id, {
        message: result.error?.message ?? "Device inference failed.",
        retryable: result.error?.retryable ?? true,
      });
    }
    const payload = deviceResultSchema.parse(result.result);
    const content: GenerateResponse["content"] = [];
    if (payload.text.length > 0) content.push({ type: "text", text: payload.text });
    for (const call of payload.toolCalls) {
      content.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
    }
    if (content.length === 0) throw new Error("Device model returned an empty response.");
    return {
      content,
      stopReason: payload.toolCalls.length > 0 ? "tool_call" : "end_turn",
      usage: { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens },
      model: `${selection.device.name}/${payload.model}`,
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.generate(request);
    const text = textOf(response.content);
    if (text.length > 0) yield { type: "text_delta", delta: text };
    for (const block of response.content) {
      if (block.type === "tool_call") yield { type: "tool_call", call: block };
    }
    yield { type: "done", response };
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    const response = await this.generate({
      ...request,
      system: `${request.system ?? ""}\nReturn only JSON matching: ${JSON.stringify(toolInputJsonSchema(schema))}`,
    });
    try {
      const text = textOf(response.content);
      return schema.parse(JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? text) as unknown);
    } catch (cause) {
      throw new LLMProviderError(this.id, {
        message: "Device model output did not match the requested schema.",
        retryable: true,
        cause,
      });
    }
  }

  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number> {
    return Promise.resolve(Math.ceil(JSON.stringify(request).length / 4));
  }
}

const deviceResultSchema = z.object({
  text: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.unknown(),
    }),
  ),
});

function providerForPaidEngine(
  engine: Extract<LlmEngineConfig, { kind: "paid-api" }>,
  apiKey: string,
): LLMProvider {
  if (engine.provider === "anthropic") {
    return new AnthropicProvider({ apiKey, model: engine.model });
  }
  const preset =
    engine.provider === "openai-compatible"
      ? { baseUrl: engine.baseUrl ?? "" }
      : PAID_PRESETS[engine.provider];
  return new OpenAICompatibleProvider({
    id: engine.id,
    model: engine.model,
    baseURL: preset.baseUrl,
    apiKey,
    ...(preset.chatCompletionsPath === undefined
      ? {}
      : { chatCompletionsPath: preset.chatCompletionsPath }),
    capabilities: { maxContextTokens: engine.maxContextTokens },
  });
}

function unavailable(message: string): LLMProviderError {
  return new LLMProviderError("nexus-unified-runtime", { message, retryable: true });
}
