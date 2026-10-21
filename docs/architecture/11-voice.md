# 11 — Voice Strategy

## 1. Principle: Voice is an I/O Transport, Not an Agent Variant

The agent core does not distinguish whether input was typed or spoken. It ingests text and produces
text. Audio processing pipelines attach **before** and **after** the core loop, never inside it
(→ [ADR-012](../adr/ADR-012-voice-decoupled.md)).

```
Microphone → [STT] → Text → Agent Core (Standard Execution) → Text → [TTS] → Audio
```

Only one contextual signal traverses the boundary: `Message.inputModality = 'voice' | 'text'`, which
the prompt uses solely to adjust response **style** (more concise phrasing, avoiding markdown tables,
avoiding reading out raw URLs). It represents a rendering directive, not altered business logic.

## 2. Port Abstractions

```ts
interface STTProvider {
  transcribe(audio: AudioBuffer, opts): Promise<Transcript>; // Batch mode
  stream(opts): STTStream; // → partial / final / VAD events
}
interface TTSProvider {
  synthesize(text, opts): Promise<AudioBuffer>;
  stream(textStream, opts): AsyncIterable<AudioChunk>; // Sentence-by-sentence streaming
  listVoices(): Promise<Voice[]>;
}
```

Supported adapters: Cloud providers (Whisper/Deepgram for STT, ElevenLabs/OpenAI for TTS), and **local
backends** (`whisper.cpp`, Piper) enabling an offline privacy mode on workstations or VPS nodes.
Choosing a backend is a configuration option, not a code rewrite.

## 3. Two Operating Modes

**Dictation Mode (v1)** — Push-to-talk: press, speak, release.

- Local audio recording (`expo-av`), lightweight voice activity detection (VAD) to trim silence, Opus upload.
- Transcription displayed and **editable prior to sending**: fixing a misinterpreted word takes seconds
  and prevents agents from acting on faulty transcriptions.
- Low token cost, minimal latency, simplest operational footprint.

**Continuous Conversation Mode (v2)** — Hands-free streaming session.

- Streaming microphone frames over WebSockets (`voice.chunk`, binary 20ms Opus frames) → real-time STT.
- Server-side speech endpointing (700ms silence or sentence closure) triggers the agent run.
- **Sentence-by-sentence TTS**: Synthesis begins as soon as the first sentence completes, while the LLM
  is still streaming subsequent tokens. This cuts perceived latency from ~4s to ~1s.
- **Barge-in Support**: If the microphone detects user speech while audio is playing, playback is
  instantly muted and the in-flight agent generation is cancelled. Without barge-in, voice assistants
  feel cumbersome.

## 4. Latency Budget

| Pipeline Stage                       | Target      | Architectural Lever                          |
| ------------------------------------ | ----------- | -------------------------------------------- |
| End of speech → Final transcript     | < 400 ms    | Streaming STT, local endpointing             |
| Transcript → First token emitted     | < 800 ms    | Pre-warmed context, fast routing model       |
| First token → First audio frame      | < 500 ms    | Sentence-by-sentence TTS streaming           |
| **Total Perceived Latency**          | **< 1.5 s** |                                              |

When an agent must execute external tools, latency naturally increases: we bridge the gap with
**local voice status announcements** ("Checking your upcoming calendar…") generated from `tool.started`
metadata rather than waiting for LLM completion tokens.

## 5. Privacy and Security Guarantees

- **Zero Audio Retention by Default**: Recordings are never persisted long term. There is no code path
  retaining raw audio files beyond the immediate transcription lifecycle.
- Zero permanent wake-word listening in v1: microphones only open upon explicit user actions. Future
  wake-word models will run **strictly on-device**, uploading zero audio prior to local activation.
- `CRITICAL` risk actions **never** accept voice authorization: irreversible mutations require explicit
  touch or biometric confirmation on a screen to eliminate accidental acoustic misinterpretations.
- Transcriptions undergo identical data redaction filters as text messages prior to logging.

## 6. Local Implementation: whisper.cpp and Piper

### Why Local Voice Matters

Spoken dictation captures **ambient household speech**. Transmitting raw audio to cloud APIs exports
sensitive ambient conversations. Synthesis poses the reciprocal risk: reading responses aloud voices
private calendar items and confidential emails.

`@nexus/voice` executes both models locally: `whisper.cpp` for STT transcription, and `Piper` for TTS
synthesis. Zero accounts, zero external API keys, zero outbound network telemetry.

### Processing Pipeline and Artifact Hygiene

```
  Dictation: Microphone (arecord) → Ephemeral WAV → whisper.cpp → Text
                                          ↑
                               Unlinked with VERIFIED deletion

  Synthesis: Text → Piper (stdin) → Raw Audio → aplay (stdin)
                         Zero filesystem writes: pure stream pipe
```

The asymmetry is inherent to the tools: `whisper.cpp` requires an input file, while `Piper` reads directly
from standard input. Thus, dictation requires verified temporary file destruction.

### Guaranteed Cleanup via `AudioScratch`

"No audio retained" must not rely on fragile developer discipline. It is enforced through `AudioScratch`
under three strict rules:

1. **Dedicated Directory**, permissions `0700`, isolated and purgeable on service boot;
2. **Verified Unlinking**: An `unlink` call whose exit code is ignored is merely an intention. If a file
   cannot be removed, dictation halts noisily rather than accumulating files;
3. **Guaranteed `finally` Execution**: Cleanup runs unconditionally on error and success paths alike.

An opt-in `diagnostic` retention flag exists solely for debugging failed transcriptions, logging an
explicit warning whenever an audio trace is preserved.

Note on storage media: File `unlink` removes filesystem references; it does not perform forensic
multi-pass disk shredding across flash blocks. The guarantee is "NEXUS retains no audio files", not
defense against forensic hardware-level chip extraction.

### Streaming Transcription Mechanics

`whisper.cpp` operates over discrete window slices, meaning **perceived transcription latency corresponds
to chunk size** (typically ~2 seconds), rather than continuous single-word streams.

### Voice Interruption (Barge-in)

An un-cancellable voice synthesis is jarring. The `stop()` primitive terminates **both** the synthesis
process and the audio player process simultaneously. Terminating only the synthesis engine would leave
the audio output buffer playing out for another second, making the system feel unresponsive.

Speech activity detection delegates to the `onSpeechDetected` interface. Without an explicit detector,
barge-in remains disabled to prevent background fan noise from constantly clipping output speech.

### Hands-Free Turn Progression

A continuous conversation turn encompasses: listen, transcribe, reason, speak, listen again — with zero
touch interaction between conversational exchanges.

Exit conditions ensure microphones do not remain indefinitely open:

| Exit Trigger       | Condition                                                        |
| ------------------ | ---------------------------------------------------------------- |
| `silence`          | A turn registers no input speech — conversation halts naturally  |
| `turn_ceiling`     | 20 turns by default                                              |
| `duration_ceiling` | 10 minutes maximum duration                                      |
| `explicit_stop`    | User invokes `stop()` or taps pause                              |

A `finally` block terminates recording handles and audio channels under all conditions, including unhandled
agent exceptions.

### Diagnostic Verification CLI

```sh
nexus voice check                      # Verifies binaries, models, and audio hardware
nexus voice dictate --seconds 5        # Executes a live dictation test
nexus voice dictate --seconds 5 --speak # Dictates and verifies synthesis playback
```

`nexus voice check` validates the four prerequisites — whisper binary, model weights, Piper binary,
voice model — reporting specific remediation steps if any component is missing.
