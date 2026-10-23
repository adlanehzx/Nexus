import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ApiClient,
  RealtimeClient,
  SessionManager,
  VoicePipeline,
  backendHttpUrl,
  clientSocketUrl,
  initialState,
  reduce,
  resyncTasks,
  type ClientState,
  type VoiceState,
} from "@nexus/client-core";
import { Platform } from "react-native";
import {
  FetchHttpClient,
  KeychainStorage,
  LocalSpeechToText,
  NativeSocket,
  OptimisticNetworkMonitor,
  PiperTextToSpeech,
} from "./platform.js";

/**
 * NEXUS context.
 *
 * A single location wires client-core and iOS platform implementations;
 * screens consume state rather than constructing dependencies. This allows swapping
 * platform ports without touching UI components.
 *
 * Domain decisions remain in `@nexus/client-core`. This file handles
 * wiring and React state integration.
 */

/**
 * Core backend URL.
 *
 * `EXPO_PUBLIC_*` is injected at build time by Expo. No server secrets
 * are embedded into mobile binaries.
 */
declare const process: { env: Record<string, string | undefined> };

// Validated rather than concatenated: remote URLs must be sanitized before handshake.
const BACKEND_URL = backendHttpUrl(process.env.EXPO_PUBLIC_NEXUS_URL ?? "https://nexus.local");
const SOCKET_URL = clientSocketUrl(process.env.EXPO_PUBLIC_NEXUS_URL ?? "https://nexus.local");

/**
 * Device name for registration.
 *
 * Also used to match existing registrations across reinstalls.
 */
const DEVICE_NAME =
  process.env.EXPO_PUBLIC_NEXUS_DEVICE_NAME ?? (Platform.OS === "ios" ? "iPhone" : "Android");

export interface NexusContextValue {
  state: ClientState;
  session: SessionManager;
  api: ApiClient;
  realtime: RealtimeClient;
  voice: VoicePipeline;
  voiceState: VoiceState;
  /** Partial transcript displayed while the user is speaking. */
  partialTranscript: string;
  ready: boolean;
  authenticated: boolean;
  /**
   * Device is registered but pending administrator approval.
   */
  devicePending: boolean;

  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  send: (text: string) => Promise<void>;
  answerConfirmation: (id: string, decision: "approved" | "rejected") => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  dismissError: () => void;
}

const NexusContext = createContext<NexusContextValue | undefined>(undefined);

/** Services constructed once for the lifetime of the provider. */
interface Services {
  session: SessionManager;
  api: ApiClient;
  realtime: RealtimeClient;
  voice: VoicePipeline;
  network: OptimisticNetworkMonitor;
}

export function NexusProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [devicePending, setDevicePending] = useState(false);

  /**
   * Services are constructed once.
   * `useRef` ensures re-renders do not create duplicate sockets.
   */
  const services = useRef<Services | null>(null);

  if (services.current === null) {
    const network = new OptimisticNetworkMonitor();
    const session = new SessionManager({
      http: new FetchHttpClient(BACKEND_URL),
      storage: new KeychainStorage(),
      onSignedOut: () => {
        setAuthenticated(false);
        setDevicePending(false);
        dispatch({ kind: "reset" });
      },
    });

    services.current = {
      session,
      network,
      api: new ApiClient(session),
      realtime: new RealtimeClient({
        socket: new NativeSocket(),
        session,
        url: SOCKET_URL,
        network,
        dispatch,
      }),
      voice: new VoicePipeline({
        speechToText: new LocalSpeechToText(),
        textToSpeech: new PiperTextToSpeech(),
        locale: "en-US",
        onStateChange: setVoiceState,
        onPartial: setPartialTranscript,
      }),
    };
  }

  const { session, api, realtime, voice } = services.current;

  /**
   * Attach the active session to a registered device.
   */
  const attachDevice = useCallback(async () => {
    const device = await session.ensureDevice({
      name: DEVICE_NAME,
      type: "IPHONE",
      platform: "IOS",
      role: "CLIENT",
    });

    setDevicePending(device.trust !== undefined && device.trust !== "TRUSTED");

    return device;
  }, [session]);

  // Session restoration on mount
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await session.restore().catch(() => false);
      if (cancelled) return;

      setAuthenticated(restored);
      setReady(true);

      if (!restored) return;

      await attachDevice()
        .then(() => realtime.start())
        .catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      realtime.stop("screen unmounted");
    };
  }, [session, realtime, attachDevice]);

  /**
   * Resync active tasks upon reconnection.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.connection !== "connected") return;

    void resyncTasks({ api, state: stateRef.current, dispatch }).catch(() => undefined);
  }, [state.connection, api]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await session.login(email, password);
      setAuthenticated(true);
      await attachDevice();
      await realtime.start();
    },
    [session, realtime, attachDevice],
  );

  const signOut = useCallback(async () => {
    realtime.stop("sign out");
    await session.logout();
    setAuthenticated(false);
    setDevicePending(false);
    dispatch({ kind: "reset" });
  }, [session, realtime]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      dispatch({
        kind: "localMessage",
        message: {
          id: `local-${String(Date.now())}`,
          role: "user",
          content: trimmed,
          streaming: false,
          createdAt: new Date().toISOString(),
          originClientDeviceId: session.deviceId,
        },
      });

      const { conversationId } = await realtime.sendMessage({
        conversationId: null,
        text: trimmed,
      });

      if (session.deviceId === null) {
        throw new Error("This device is not yet registered with NEXUS. Open settings to pair it.");
      }

      await api.instruct({
        instruction: trimmed,
        originClientDeviceId: session.deviceId,
        conversationId,
      });
    },
    [realtime, session, api],
  );

  const answerConfirmation = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      dispatch({ kind: "confirmationAnswered", confirmationId: id });
      await realtime.respondToConfirmation(id, decision);
    },
    [realtime],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      await realtime.cancelTask(taskId);
    },
    [realtime],
  );

  const refreshDevices = useCallback(async () => {
    const devices = await api.listDevices();
    dispatch({
      kind: "devices",
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        role: device.role,
        status: device.status,
        capabilities: device.capabilities,
        lastSeenAt: device.lastSeenAt,
      })),
    });
  }, [api]);

  const markNotificationRead = useCallback(
    async (id: string) => {
      dispatch({ kind: "notificationRead", notificationId: id, at: new Date().toISOString() });
      await api.markNotificationRead(id).catch(() => undefined);
    },
    [api],
  );

  const dismissError = useCallback(() => {
    dispatch({ kind: "clearError" });
  }, []);

  const value = useMemo<NexusContextValue>(
    () => ({
      state,
      session,
      api,
      realtime,
      voice,
      voiceState,
      partialTranscript,
      ready,
      authenticated,
      devicePending,
      signIn,
      signOut,
      send,
      answerConfirmation,
      cancelTask,
      refreshDevices,
      markNotificationRead,
      dismissError,
    }),
    [
      state,
      session,
      api,
      realtime,
      voice,
      voiceState,
      partialTranscript,
      ready,
      authenticated,
      devicePending,
      signIn,
      signOut,
      send,
      answerConfirmation,
      cancelTask,
      refreshDevices,
      markNotificationRead,
      dismissError,
    ],
  );

  return <NexusContext.Provider value={value}>{children}</NexusContext.Provider>;
}

/**
 * Access the NEXUS context.
 *
 * Throws outside provider rather than returning undefined.
 */
export function useNexus(): NexusContextValue {
  const value = useContext(NexusContext);
  if (value === undefined) {
    throw new Error("useNexus must be used within <NexusProvider>");
  }
  return value;
}
