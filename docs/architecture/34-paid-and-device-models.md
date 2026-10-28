# Paid APIs and device-hosted models

NEXUS exposes one model router to Agent Core and the mission orchestrator. The router can combine:

- subscription-backed CLI/ACP providers already connected to NEXUS;
- paid API accounts configured by an administrator;
- FreeLLM and its free-tier backends;
- private models hosted on a paired NEXUS worker.

Paid providers are configured from **Settings → Model engines**. The dashboard writes the API key
once to the encrypted vault and persists only a `vault://nexus/...` reference in runtime
configuration. Supported presets are OpenAI, Anthropic, Google Gemini API, OpenRouter, Mistral,
DeepSeek, and a custom OpenAI-compatible HTTPS endpoint. Provider keys are resolved only when the
API process builds a request; they are never sent to an agent prompt, a worker, or a dashboard read
response.

## Private model on another device

Install Ollama or an OpenAI-compatible server on the worker machine and bind it to loopback. Pair
the worker with the optional model flags:

```bash
printf '%s' "$PAIRING_TICKET" | node dist/pair.js \
  --token-stdin \
  --api-url https://nexus.example \
  --platform LINUX \
  --name "GPU workstation" \
  --key-path /var/lib/nexus/device.key \
  --env-path /etc/nexus/worker.env \
  --llm-runtime ollama \
  --llm-url http://127.0.0.1:11434 \
  --llm-model qwen3:14b
```

After pairing:

1. approve the worker on the **Devices** page;
2. grant the `llm.inference` permission;
3. wait until the worker is online and authenticated;
4. add it under **Settings → Model engines** and use **Test**.

The model endpoint is restricted to `localhost`, `127.0.0.1`, or `::1`. NEXUS transports the prompt
through the worker's authenticated WebSocket and therefore does not require a public Ollama/vLLM
port. An optional compatible-server key remains in the worker environment and never crosses into
Core.

## Routing behavior

Enabled configured engines are ordered by priority. With **Prefer private device models** enabled,
eligible device engines run before paid APIs regardless of numeric priority. Failures flow through
the existing retryable fallback chain, followed by subscription-backed providers and FreeLLM.
Device selection is scoped to the authenticated owner and requires a trusted, online, authenticated
worker that both advertises and is granted `llm.inference`.

The router does not claim that a paid account has usable quota. The **Test** action performs one
small real request and can consume provider quota.
