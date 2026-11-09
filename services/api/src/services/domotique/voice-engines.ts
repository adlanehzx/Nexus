import {
  AudioScratch,
  PiperBufferSynthesizer,
  WhisperBufferTranscriber,
  systemFiles,
  systemProcess,
  type SpeechToTextPort,
  type TextToSpeechPort,
} from "@nexus/voice";

/**
 * Satellite speech engines from the environment. Both are opt-in: without a
 * model path the engine is absent and the satellite protocol reports it
 * (`ready.stt` / `ready.tts` = false) instead of pretending.
 *
 *   NEXUS_SATELLITE_WHISPER_MODEL  path to a whisper.cpp ggml model (enables STT)
 *   NEXUS_SATELLITE_WHISPER_BIN    whisper.cpp binary (default `whisper-cli`)
 *   NEXUS_SATELLITE_PIPER_MODEL    path to a Piper `.onnx` voice (enables TTS)
 *   NEXUS_SATELLITE_PIPER_BIN      Piper binary (default `piper`)
 *   NEXUS_SATELLITE_PIPER_RATE     voice sample rate (default 22050)
 *   NEXUS_VOICE_LANGUAGE           whisper language (default `fr`)
 */
export function satelliteVoicePortsFromEnv(
  env: NodeJS.ProcessEnv,
  scratchDirectory: string,
): { stt?: SpeechToTextPort; tts?: TextToSpeechPort } {
  const ports: { stt?: SpeechToTextPort; tts?: TextToSpeechPort } = {};
  const whisperModel = env.NEXUS_SATELLITE_WHISPER_MODEL?.trim();
  const language = env.NEXUS_VOICE_LANGUAGE?.trim();
  if (whisperModel) {
    ports.stt = new WhisperBufferTranscriber({
      process: systemProcess,
      scratch: new AudioScratch({ files: systemFiles, directory: scratchDirectory }),
      modelPath: whisperModel,
      ...(env.NEXUS_SATELLITE_WHISPER_BIN ? { binary: env.NEXUS_SATELLITE_WHISPER_BIN } : {}),
      language: language === undefined || language === "" ? "fr" : language,
    });
  }
  const piperModel = env.NEXUS_SATELLITE_PIPER_MODEL?.trim();
  if (piperModel) {
    const rate = Number(env.NEXUS_SATELLITE_PIPER_RATE ?? "22050");
    ports.tts = new PiperBufferSynthesizer({
      modelPath: piperModel,
      ...(env.NEXUS_SATELLITE_PIPER_BIN ? { binary: env.NEXUS_SATELLITE_PIPER_BIN } : {}),
      sampleRate: Number.isFinite(rate) && rate > 0 ? rate : 22_050,
    });
  }
  return ports;
}
