import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-speech", () => ({
  speak: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  isSpeakingAsync: vi.fn().mockResolvedValue(false),
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@react-native-community/netinfo", () => ({
  default: { addEventListener: vi.fn(() => () => undefined) },
}));

import {
  describeSocketClose,
  ExpoTextToSpeech,
  NativeSpeechToText,
  NativeSocket,
  TimeoutHttpClient,
  isOnline,
  type SpeechRecognitionModule,
} from "../lib/platform.js";

type Listener = Parameters<SpeechRecognitionModule["addListener"]>[1];

function fakeRecognizer(available = true) {
  const listeners = new Map<string, Listener>();
  const module = {
    isRecognitionAvailable: vi.fn(() => available),
    requestPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
    start: vi.fn(),
    stop: vi.fn(() => {
      listeners.get("result")?.({ isFinal: true, results: [{ transcript: "open chrome" }] });
      listeners.get("end")?.({});
    }),
    abort: vi.fn(),
    addListener: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return {
        remove: () => {
          listeners.delete(event);
        },
      };
    }),
  } satisfies SpeechRecognitionModule;
  return { module, listeners };
}

describe("NativeSpeechToText", () => {
  it("reports unavailable when the native module is absent", async () => {
    const stt = new NativeSpeechToText(() => undefined);
    expect(await stt.isAvailable()).toBe(false);
    expect(await stt.requestPermission()).toBe(false);
    await expect(stt.start()).rejects.toThrow(/unavailable/);
  });

  it("streams partials and returns the final transcript on stop", async () => {
    const { module, listeners } = fakeRecognizer();
    const partials: string[] = [];
    const stt = new NativeSpeechToText(() => module);

    await stt.start({
      locale: "fr-FR",
      onPartial: (text) => {
        partials.push(text);
      },
    });
    listeners.get("result")?.({ isFinal: false, results: [{ transcript: "open" }] });

    expect(module.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "fr-FR" }));
    expect(await stt.stop()).toEqual({ text: "open chrome" });
    expect(partials).toEqual(["open", "open chrome"]);
    expect(listeners.size).toBe(0);
  });

  it("discards everything on cancel", async () => {
    const { module, listeners } = fakeRecognizer();
    const stt = new NativeSpeechToText(() => module);

    await stt.start();
    listeners.get("result")?.({ isFinal: true, results: [{ transcript: "secret" }] });
    await stt.cancel();

    expect(module.abort).toHaveBeenCalled();
    expect(await stt.stop()).toEqual({ text: "" });
  });

  it("surfaces a recognizer fault but not a silent press", async () => {
    const { module, listeners } = fakeRecognizer();
    module.stop.mockImplementation(() => undefined);
    const stt = new NativeSpeechToText(() => module);

    await stt.start();
    listeners.get("error")?.({ error: "no-speech" });
    expect(await stt.stop()).toEqual({ text: "" });

    await stt.start();
    listeners.get("error")?.({ error: "network", message: "recognizer offline" });
    await expect(stt.stop()).rejects.toThrow("recognizer offline");
  });
});

describe("ExpoTextToSpeech", () => {
  it("is the real OS engine contract", async () => {
    const tts = new ExpoTextToSpeech();
    expect(await tts.isAvailable()).toBe(true);
    expect(await tts.isSpeaking()).toBe(false);
    await expect(tts.stop()).resolves.toBeUndefined();
  });
});

describe("isOnline", () => {
  it("treats an unprobed network as online and a confirmed loss as offline", () => {
    expect(isOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnline({ isConnected: null, isInternetReachable: null })).toBe(true);
    expect(isOnline({ isConnected: false, isInternetReachable: null })).toBe(false);
    expect(isOnline({ isConnected: true, isInternetReachable: false })).toBe(false);
  });
});

describe("TimeoutHttpClient", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits content-type on bodyless POST, which Fastify would reject", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new TimeoutHttpClient("https://nexus.test").request({
      method: "POST",
      path: "/api/v1/devices/d1/trust",
    });

    expect(fetchMock.mock.calls[0]?.[1].headers).toEqual({});
  });

  it("aborts a request that outlives its deadline", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    await expect(
      new TimeoutHttpClient("https://nexus.test", 5).request({ method: "GET", path: "/x" }),
    ).rejects.toThrow("aborted");
  });
});

describe("NativeSocket", () => {
  it("ignores the late close of a replaced socket", async () => {
    const created: FakeSocket[] = [];
    class FakeSocket {
      onopen?: () => void;
      onclose?: (event: { reason?: string; code?: number }) => void;
      onerror?: () => void;
      onmessage?: (event: { data: unknown }) => void;
      close = vi.fn();
      send = vi.fn();
      constructor() {
        created.push(this);
        queueMicrotask(() => this.onopen?.());
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    const closes: string[] = [];
    const socket = new NativeSocket();
    socket.onClose((reason) => {
      closes.push(reason);
    });

    await socket.connect("wss://nexus.test/ws/client");
    await socket.connect("wss://nexus.test/ws/client");
    created[0]?.onclose?.({ reason: "stale" });

    expect(closes).toEqual([]);
    expect(socket.state).toBe("open");

    created[1]?.onclose?.({ reason: "dropped", code: 1006 });
    expect(closes).toEqual(["dropped"]);
  });
});

describe("describeSocketClose", () => {
  it("names the origin to allow when the handshake is refused", () => {
    expect(
      describeSocketClose(
        "Expected HTTP 101 response but was '403 Forbidden'",
        "wss://nexus.example.com/ws/client",
      ),
    ).toBe(
      "the core does not allow https://nexus.example.com: add it to CORS_ORIGINS on the server",
    );
    expect(describeSocketClose("HTTP 403", "ws://10.0.2.2:3910/ws/client")).toContain(
      "http://10.0.2.2:3910",
    );
  });

  it("leaves other close reasons untouched", () => {
    expect(describeSocketClose("socket closed", "wss://nexus.example.com/ws/client")).toBe(
      "socket closed",
    );
  });
});
