import type {
  NetworkMonitor,
  SocketState,
  SocketTransport,
  SpeechToTextProvider,
  TextToSpeechProvider,
  TranscriptionResult,
} from "@nexus/client-core";

// `FetchHttpClient` lives in `@nexus/client-core`.
export { FetchHttpClient } from "@nexus/client-core";

/**
 * Platform ports for the Windows desktop client.
 *
 * Implements WebSocket transport, network monitoring, and browser speech APIs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Network
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renderer WebSocket transport.
 *
 * Auth token is exchanged during the initial frame, not in the URL.
 */
export class BrowserSocket implements SocketTransport {
  #socket: WebSocket | undefined;
  #state: SocketState = "idle";
  #onMessage: ((data: string) => void) | undefined;
  #onClose: ((reason: string, code?: number) => void) | undefined;

  get state(): SocketState {
    return this.#state;
  }

  connect(url: string): Promise<void> {
    this.#state = "connecting";

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#socket = socket;

      socket.onopen = () => {
        this.#state = "open";
        resolve();
      };

      socket.onerror = () => {
        if (this.#state === "connecting") reject(new Error("connection failed"));
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") this.#onMessage?.(event.data);
      };

      socket.onclose = (event) => {
        this.#state = "closed";
        this.#onClose?.(event.reason.length > 0 ? event.reason : "socket closed", event.code);
      };
    });
  }

  send(data: string): void {
    this.#socket?.send(data);
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#socket?.close(1000, reason);
  }

  onMessage(handler: (data: string) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string, code?: number) => void): void {
    this.#onClose = handler;
  }
}

/**
 * Network state monitoring.
 */
export class BrowserNetworkMonitor implements NetworkMonitor {
  #handler: ((online: boolean) => void) | undefined;

  constructor() {
    globalThis.addEventListener("online", () => {
      this.#handler?.(true);
    });
    globalThis.addEventListener("offline", () => {
      this.#handler?.(false);
    });
  }

  isOnline(): boolean {
    return navigator.onLine;
  }

  onChange(handler: (online: boolean) => void): void {
    this.#handler = handler;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Speech synthesis via Web Speech API.
 */
export class WebTextToSpeech implements TextToSpeechProvider {
  isAvailable(): Promise<boolean> {
    return Promise.resolve("speechSynthesis" in globalThis);
  }

  speak(text: string, options?: { locale?: string; rate?: number }): Promise<void> {
    globalThis.speechSynthesis.cancel();

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options?.locale ?? "en-US";
      utterance.rate = options?.rate ?? 1;
      utterance.onend = () => {
        resolve();
      };
      utterance.onerror = () => {
        reject(new Error("speech synthesis unavailable"));
      };
      globalThis.speechSynthesis.speak(utterance);
    });
  }

  stop(): Promise<void> {
    globalThis.speechSynthesis.cancel();
    return Promise.resolve();
  }

  isSpeaking(): Promise<boolean> {
    return Promise.resolve(globalThis.speechSynthesis.speaking);
  }
}

/**
 * Minimal Web Speech Recognition interface.
 */
interface WebSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: WebSpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface WebSpeechResultEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string; confidence: number } };
  };
}

type RecognitionConstructor = new () => WebSpeechRecognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/**
 * Speech-to-text via Web Speech API.
 */
export class WebSpeechToText implements SpeechToTextProvider {
  #recognition: WebSpeechRecognition | undefined;
  #transcript = "";
  #confidence: number | undefined;
  #ended: Promise<void> | undefined;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(recognitionConstructor() !== undefined);
  }

  /**
   * Microphone permission check.
   */
  async requestPermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch {
      return false;
    }
  }

  start(options?: { locale?: string; onPartial?: (text: string) => void }): Promise<void> {
    const Recognition = recognitionConstructor();
    if (Recognition === undefined) {
      return Promise.reject(new Error("speech recognition unavailable"));
    }

    const recognition = new Recognition();
    recognition.lang = options?.locale ?? "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;

    this.#transcript = "";
    this.#confidence = undefined;
    this.#recognition = recognition;

    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result === undefined) continue;

        if (result.isFinal) {
          this.#transcript += result[0].transcript;
          this.#confidence = result[0].confidence;
        } else {
          options?.onPartial?.(this.#transcript + result[0].transcript);
        }
      }
    };

    this.#ended = new Promise<void>((resolve) => {
      recognition.onend = () => {
        resolve();
      };
      recognition.onerror = () => {
        resolve();
      };
    });

    recognition.start();
    return Promise.resolve();
  }

  async stop(): Promise<TranscriptionResult> {
    this.#recognition?.stop();
    await this.#ended;
    this.#recognition = undefined;

    return {
      text: this.#transcript.trim(),
      ...(this.#confidence === undefined ? {} : { confidence: this.#confidence }),
    };
  }

  async cancel(): Promise<void> {
    this.#recognition?.abort();
    await this.#ended;
    this.#recognition = undefined;
    this.#transcript = "";
  }
}
