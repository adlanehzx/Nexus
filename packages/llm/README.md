# NEXUS engine contract

`@nexus/llm` is the provider-neutral generation port. It includes direct adapters for the native
Antigravity CLI, DeepSeek, FreeLLM-compatible endpoints, Ollama, llama.cpp, and vLLM. The HTTP
adapters execute real requests against their documented local or OpenAI-compatible surfaces; no
provider is required for personal mode.

FreeLLM `0.5.2` is also integrated natively as an optional final fallback. Its NVIDIA NIM key is
resolved from the NEXUS vault at request time, never from dashboard-visible configuration. Anonymous
Kilo and OVH routes remain disabled until the administrator explicitly accepts their weaker prompt
privacy. The dashboard can change this configuration without restarting NEXUS.

The conformance suite uses a real loopback HTTP server and a real subprocess fixture. It verifies
generation, streaming, structured output, usage mapping, token counting, normalized failures, and
that provider stderr is never returned. This is faithful virtualization, not a claim that an external
account or hosted provider was contacted.

Routing descriptors carry quality, latency, cost, context capacity, privacy class, availability, and
nullable quota. A missing quota is serialized as `unknown` and receives a neutral score. It is never
treated as unlimited. `TaskBoundaryEngineRouter` persists a decision before returning it; Mission
Engine uses the same rule for durable attempts and fallback.

The native Antigravity harness invokes `agy` directly with print mode. It is intentionally separate
from the community `google-antigravity-acp` adapter. Tests replace `agy` with a controlled executable;
the host capability check is limited to `agy --version` and consumes no model quota.
