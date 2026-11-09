# ESP32 voice satellite protocol, v1

This document is the contract between the NEXUS API and the firmware of the
ESP32 satellites (microphone now, speaker next). It covers transport, message
formats and audio formats. The firmware itself is out of scope.

The satellite keeps its existing HTTP channel for heartbeat, commands and mic
mute (`/api/v1/satellites/:id/...`). The voice channel below is an addition,
and it uses the **same per-device token**.

## Pipeline

```
[ESP32] wake word (on device)
   -> "wake" + microphone PCM stream ------------------------> [NEXUS /ws/satellite]
                                                                whisper.cpp STT
                                                                intent: home control
                                                                  (or NEXUS agent)
                                                                Piper TTS
   <- "transcript", "reply", "tts.start" + PCM + "tts.end" --- to THIS satellite only
```

Wake-word detection runs on the device. NEXUS never receives ambient audio:
any audio received outside a listening turn is dropped.

## Transport

- WebSocket: `ws://<nexus-host>:<API_PORT>/ws/satellite`, or `wss://` behind
  TLS.
- **Text frames** carry UTF-8 JSON control messages. Every message has
  `"v": 1` and a `"type"`.
- **Binary frames** carry raw audio: PCM samples only, with no header or
  framing.
- Maximum frame size: 256 KiB. In practice, send 20 to 100 ms of audio per
  frame (640 to 3,200 bytes).
- Handshake deadline: the device must send `hello` within 10 s. Otherwise
  NEXUS closes the socket with code `4401`.
- The server sends WebSocket pings every 30 s. The device should also send
  `{"v":1,"type":"ping"}` every 30 s to detect stale links.

### Close codes

| Code   | Meaning                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------ |
| `4401` | Missing or invalid `hello`, unknown device, or wrong token. NEXUS gives the same answer in every case. |
| `4400` | Protocol error: a binary frame or invalid JSON arrived before `hello`.                                 |

After any other close, the device should reconnect with exponential backoff
from 1 s to 60 s.

## Authentication: `hello`

The first frame must be:

```json
{
  "v": 1,
  "type": "hello",
  "deviceId": "esp32-salon",
  "token": "<device token from QR pairing>",
  "firmware": "1.4.0",
  "audio": {
    "mic": { "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1 },
    "speaker": { "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1 }
  }
}
```

- `deviceId` matches `^[a-zA-Z0-9_-]{1,47}$`. It must be paired, which means
  its SHA-256 token digest is in `SATELLITE_TOKEN_HASHES_JSON`.
- `token` is the device secret. NEXUS compares SHA-256 digests in constant
  time. Send it over `wss://` whenever NEXUS is reached through anything
  other than a trusted LAN.
- `audio.speaker` declares the speaker capability. Omit it for mic-only
  hardware, and NEXUS replies with text only. Accepted speaker sample rates:
  `16000` (recommended), `22050` and `24000`.

NEXUS answers:

```json
{
  "v": 1,
  "type": "ready",
  "deviceId": "esp32-salon",
  "stt": true,
  "tts": true,
  "mic": { "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1 },
  "speaker": { "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1 }
}
```

`stt` or `tts` is `false` when that engine is not configured on the NEXUS host.
In that case, show an error LED pattern instead of waiting for audio.

The satellite should also add `{"name": "audio.speaker"}` to the
`capabilities` of its HTTP heartbeat, so that the dashboard shows the speaker
while the voice socket is down.

## Audio formats

| Direction                       | Format                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Microphone in (device to NEXUS) | PCM signed 16-bit little-endian, **mono, 16,000 Hz**. One second is 32,000 bytes.                           |
| Speaker out (NEXUS to device)   | PCM signed 16-bit little-endian, mono, at the `speaker.sampleRate` declared in `hello` (default 16,000 Hz). |

Piper produces 22,050 Hz. NEXUS resamples to the declared rate, so the I2S
DAC can run at one fixed rate.

## Voice turn

| Step | Device sends                                                                            | NEXUS sends                                                                                                      |
| ---- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1    | `{"v":1,"type":"wake","wakeWord":"nexus","score":0.91}`                                 | `{"v":1,"type":"listening","turnId":"..."}`                                                                      |
| 2    | Binary PCM frames                                                                       |                                                                                                                  |
| 3    | `{"v":1,"type":"audio.end"}` when the device's VAD detects the end of speech (optional) |                                                                                                                  |
| 4    |                                                                                         | `{"v":1,"type":"transcript","turnId":"...","text":"allume la lumière du salon"}`                                 |
| 5    |                                                                                         | `{"v":1,"type":"reply","turnId":"...","text":"C'est fait : Lampe salon."}`                                       |
| 6    |                                                                                         | `{"v":1,"type":"tts.start","turnId":"...","encoding":"pcm_s16le","sampleRate":16000,"channels":1,"bytes":48000}` |
| 7    |                                                                                         | Binary PCM frames of 4,096 bytes or less                                                                         |
| 8    |                                                                                         | `{"v":1,"type":"tts.end","turnId":"...","interrupted":false}`                                                    |
| 9    | `{"v":1,"type":"playback.done","turnId":"..."}` (optional)                              |                                                                                                                  |

Notes on each step:

- **Step 1.** The device sends `wake` after its wake word fires, then starts
  streaming.
- **Step 3.** NEXUS also detects the end of speech on its side: about 1 s of
  silence after speech, using the satellite acoustic profile. A turn is capped
  at **15 s** of audio. The end of speech closes the turn even if the device
  never sends `audio.end`.
- **Step 4.** The transcript is empty if nothing intelligible was heard.
- **Step 5.** The reply text is always sent, even without a speaker.
- **Steps 6 to 8** happen only when the device declared a speaker and TTS is
  configured. `bytes` is the total payload size, so the device can size its
  ring buffer. The device should start playback once it has about 100 ms
  buffered.

### Interruption

- A new `wake` during processing or playback (barge-in) cancels the current
  turn and opens a new one.
- `{"v":1,"type":"cancel"}` aborts the turn, for example when the user presses
  a button.
- When playback is cut short, NEXUS sends `tts.end` with `"interrupted": true`.

### Errors

```json
{ "v": 1, "type": "error", "turnId": "...", "code": "VOICE_UNAVAILABLE", "message": "..." }
```

| Code                | Meaning                                              |
| ------------------- | ---------------------------------------------------- |
| `VOICE_UNAVAILABLE` | STT or TTS is missing on the host.                   |
| `TURN_FAILED`       | Any other failure. NEXUS never forwards the details. |
| `UNKNOWN_FRAME`     | Unrecognised control message.                        |

Error messages never include host paths or internal details.

## What a voice turn can do

The transcript is first parsed as a **home command**, in French or English:
turn on or off, brightness percentage, colour names, TV play, pause, volume
and mute, lock and unlock, open and close covers, and "lance la scène X".
These commands run through the same path as the dashboard:
`DomotiqueService.executeAction`.

- When the sentence names no room, the satellite's own room is the default
  target. In the kitchen, "allume la lumière" lights the kitchen.
- Sensitive devices are **not** actuated by voice. NEXUS creates a dashboard
  confirmation and the spoken reply says so.
- Anything else goes to the NEXUS agent, when an LLM is configured. Each
  satellite gets its own conversation.

## Host configuration (speech engines)

Both engines are opt-in, through environment variables on the API host:

| Variable                        | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `NEXUS_SATELLITE_WHISPER_MODEL` | Path to a whisper.cpp ggml model. Enables STT. |
| `NEXUS_SATELLITE_WHISPER_BIN`   | whisper.cpp binary. Default: `whisper-cli`.    |
| `NEXUS_SATELLITE_PIPER_MODEL`   | Path to a Piper `.onnx` voice. Enables TTS.    |
| `NEXUS_SATELLITE_PIPER_BIN`     | Piper binary. Default: `piper`.                |
| `NEXUS_SATELLITE_PIPER_RATE`    | Sample rate of the voice. Default: `22050`.    |
| `NEXUS_VOICE_LANGUAGE`          | Whisper language. Default: `fr`.               |

During STT, utterance audio is written to a temporary WAV under
`var/voice-scratch/`, owner-only. NEXUS deletes it right after transcription
and verifies the deletion through `AudioScratch`. Speech synthesis stays in
memory and never touches the disk.

## Status

`GET /api/v1/domotique/voice` shows, for each owned satellite: the voice link
state, whether the microphone and speaker are present, the speaker sample
rate, the firmware version, and the turn count. It also shows whether the STT
and TTS engines are configured. The dashboard's **Satellites vocaux** panel
uses this endpoint.
