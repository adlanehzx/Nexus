# ADR-012 — Voice is Decoupled from the Agent Core

**Status**: Proposed · 2026-09-01

## Context

The product must accept spoken input and respond with natural voice synthesis. The temptation is to
adopt an end-to-end "speech-to-speech" multimodal API or introduce voice-specific branching inside
the agent execution path. The system requirements explicitly state: "do not couple voice logic to
the agent backend".

## Decision

Speech-to-Text (STT) and Text-to-Speech (TTS) are decoupled input/output transport layers wrapping
an agent core that operates strictly on text. Decoupled ports `STTProvider` and `TTSProvider` live
in `@nexus/voice`, with cloud and local adapters (`whisper.cpp`, Piper). Only one signal crosses the
boundary: `Message.inputModality`, used solely to subtly adjust response **style** (shorter phrases,
no raw markdown tables, avoid spelling out raw URLs).

Two modes: dictation (v1, editable transcription before sending) and continuous conversation
(v2, streaming chunks, speech endpointing, sentence-by-sentence TTS, barge-in support).

## Alternatives

- **End-to-end speech-to-speech API.** Excellent latency and natural prosody. Rejected for v1: the
  voice model acts as the brain, short-circuiting the durable agent loop, permissions, confirmation
  gates, and memory systems — essentially bypassing the core product architecture. Can be considered
  later **behind the same port** for purely conversational interactions without tool usage.
- **On-device STT/TTS only.** Maximum privacy and zero server compute costs, but uneven quality and
  latency across varied mobile devices, and cannot share synthesized voice state across machines.
  Retained as a configurable option, not default.
- **Separate agent pipeline for voice.** Duplicates core business logic, doubling surface area for
  bugs. Rejected on principle.

## Consequences

**Positive** — A single execution flow to test, audit, and secure; switching STT or TTS providers is
a matter of configuration; an "all-local" privacy mode remains easily attainable; voice
confirmations inherit identical permission policies as text.

**Negative, accepted** — Higher latency than a native speech-to-speech neural pipeline (target
perceived latency < 1.5s, achieved through streaming sentence-by-sentence TTS); STT transcription
errors enter the context as literal text — requiring editable previews in dictation mode, and
prohibiting verbal approval of `CRITICAL` actions.
