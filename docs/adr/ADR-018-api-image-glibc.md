# ADR-018 — A glibc Base for the API Image

**Status**: Accepted · 2026-11-03

## Context

Memory is advertised as semantic: pgvector storage, a multilingual sentence model, recall by
meaning. `MEMORY_EMBEDDING_BACKEND` defaults to `neural`, which runs
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` locally through `onnxruntime-node`.

That package publishes prebuilt binaries for glibc only. The API image was
`node:24-alpine`, which is musl. Loading failed:

```
Error loading shared library ld-linux-x86-64.so.2: No such file or directory
  (needed by onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1)
```

The consequences were invisible from outside. `POST /api/v1/memory` answered `500` while
`GET /api/v1/memory` answered `200`, so the Memory page listed records and refused to save
them. Mission planning lost its memory context. And nothing reported the embedding backend at
startup or in any response, so an installation running without semantic recall was
indistinguishable from one running with it.

The defect predates this change: both the deployed image and a fresh rebuild reproduced it, and
it had never surfaced because a separate defect stopped missions earlier (ADR-017).

## Decision

**The API image is built on `node:${NODE_VERSION}-bookworm-slim`.** Both the build and runtime
stages change together: `pnpm deploy` copies the builder's `node_modules` into the runtime, so a
musl build tree under a glibc runtime would be incoherent — and Prisma's query engine is
selected per libc at install time for the same reason.

**`neural` stays the default.** The alternative was to set `MEMORY_EMBEDDING_BACKEND=hash`,
which would have made the symptom disappear while quietly removing the capability. Feature
hashing cannot rank a paraphrase above an unrelated sentence, and `test:embeddings` records that
difference as an executable fact rather than a claim.

**The live backend is logged at boot.** One `memory.embeddings` line names the backend, the
model, and whether semantic recall is on. An operator who chooses `hash` now chooses it
knowingly; one who inherits it finds out at startup rather than from poor results.

## Alternatives

- **`gcompat` on Alpine.** Tested, rejected: it supplies `ld-linux-x86-64.so.2`, then fails with
  `Error relocating … fcntl64: symbol not found`. It moves the error, it does not remove it.
- **`MEMORY_EMBEDDING_BACKEND=hash`.** Rejected: it degrades a headline capability silently,
  which is the exact failure mode this work exists to eliminate.
- **A separate embeddings service on a glibc base.** A sound end state, and the right answer if
  embeddings ever need their own scaling or a GPU. Rejected for now as a larger change than the
  defect warrants: it adds a service, a transport and a failure mode to fix a base-image choice.
- **Build `onnxruntime` from source for musl.** Rejected: pinning a self-built native runtime is
  a maintenance burden far exceeding the image-size saving.

## Consequences

- The image grows: `bookworm-slim` carries more than `alpine`. Measured and accepted as the cost
  of a working capability.
- `apk` becomes `apt-get` in the runtime stage, with the package lists removed in the same layer.
- Other images are untouched. Only the API loads `onnxruntime-node`.
- CI runners are glibc, so `test:embeddings` is runnable there; it stays out of the default suite
  because it downloads a model and runs for minutes.
- The musl incompatibility is a property of `onnxruntime-node`, not of this repository. Any
  future native dependency with glibc-only prebuilts is now already accommodated.
