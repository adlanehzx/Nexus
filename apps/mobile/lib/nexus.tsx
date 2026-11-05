import "./web-crypto.js";
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
  resyncTasks,
  type ClientAction,
  type ClientState,
  type NotificationView,
  type VoiceState,
} from "@nexus/client-core";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import { MobileApi } from "./api.js";
import { ChatController, initialChatState, type ChatState } from "./chat-controller.js";
import { reduceMobile, type SendMode } from "./chat-state.js";
import { failureMessage } from "./errors.js";
import { alertForFrame, presentLocalAlert } from "./notifications.js";
import {
  ExpoTextToSpeech,
  KeychainStorage,
  NativeNetworkMonitor,
  NativeSocket,
  NativeSpeechToText,
  TimeoutHttpClient,
} from "./platform.js";
import { readPreference, writePreference } from "./preferences.js";
import { clearResourceCache } from "./resource-cache.js";

/**
 * NEXUS context.
 *
 * A single location wires client-core and platform implementations; screens
 * consume state rather than constructing dependencies. Mounted once per server
 * address (the root layout keys it): changing server rebuilds every service,
 * which is what keeps a socket from outliving the address it was opened for.
 *
 * Domain decisions remain in `@nexus/client-core`. This file handles wiring,
 * lifecycle, and React state integration.
 */

/** Used to match the existing registration of this phone across reinstalls. */
const DEVICE_NAME = Device.modelName ?? (Platform.OS === "ios" ? "iPhone" : "Android");

/** How often to look for an administrator's approval of this device. */
const APPROVAL_POLL_MS = 15_000;

export type DeviceTrust = "unknown" | "trusted" | "pending" | "revoked";

export interface NexusContextValue {
  serverUrl: string;
  state: ClientState;
  chat: ChatState;
  session: SessionManager;
  api: ApiClient;
  mobile: MobileApi;
  realtime: RealtimeClient;
  voice: VoicePipeline;
  voiceState: VoiceState;
  /** Partial transcript displayed while the user is speaking. */
  partialTranscript: string;
  ready: boolean;
  authenticated: boolean;
  deviceTrust: DeviceTrust;
  /** Device is registered but pending administrator approval. */
  devicePending: boolean;
  sendMode: SendMode;

  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  send: (text: string) => Promise<boolean>;
  setSendMode: (mode: SendMode) => void;
  newConversation: () => void;
  openConversation: (conversationId: string) => Promise<void>;
  answerConfirmation: (id: string, decision: "approved" | "rejected") => Promise<void>;
  answerRunConfirmation: (decision: "approved" | "rejected") => Promise<void>;
  stopRun: () => Promise<boolean>;
  cancelTask: (taskId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
  refreshDeviceTrust: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  hydrateNotifications: (notifications: NotificationView[]) => void;
  setSpeakReplies: (enabled: boolean) => void;
  reportError: (cause: unknown) => void;
  dismissError: () => void;
}

const NexusContext = createContext<NexusContextValue | undefined>(undefined);

/** Services constructed once for the lifetime of the provider. */
interface Services {
  session: SessionManager;
  api: ApiClient;
  mobile: MobileApi;
  realtime: RealtimeClient;
  voice: VoicePipeline;
  chat: ChatController;
  network: NativeNetworkMonitor;
}

export function NexusProvider({
  serverUrl,
  children,
}: {
  serverUrl: string;
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(reduceMobile, initialState);
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [deviceTrust, setDeviceTrust] = useState<DeviceTrust>("unknown");
  const [sendMode, setSendModeState] = useState<SendMode>("chat");

  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Services are constructed once.
   * `useRef` ensures re-renders do not create duplicate sockets.
   */
  const services = useRef<Services | null>(null);

  if (services.current === null) {
    const network = new NativeNetworkMonitor();
    const session = new SessionManager({
      http: new TimeoutHttpClient(backendHttpUrl(serverUrl)),
      storage: new KeychainStorage(),
      onSignedOut: () => {
        // The core refused the session: nothing of this account stays on screen or open.
        clearResourceCache();
        services.current?.realtime.stop("session ended");
        setAuthenticated(false);
        setDeviceTrust("unknown");
        dispatch({ kind: "reset" });
      },
    });
    const api = new ApiClient(session);
    const mobile = new MobileApi(session);

    const voice = new VoicePipeline({
      speechToText: new NativeSpeechToText(),
      textToSpeech: new ExpoTextToSpeech(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      onStateChange: setVoiceState,
      onPartial: setPartialTranscript,
    });

    const onRealtimeAction = (action: ClientAction) => {
      dispatch(action);
      if (action.kind !== "server") return;

      // A streamed answer is read aloud once complete, like a REST answer.
      if (action.type === SERVER_TO_CLIENT.messageDelta && action.payload.done === true) {
        const id = action.payload.messageId;
        const message = stateRef.current.messages.find((candidate) => candidate.id === id);
        const delta = typeof action.payload.delta === "string" ? action.payload.delta : "";
        if (message !== undefined) void voice.speak(message.content + delta);
      }

      // On screen, the in-app card already shows it.
      if (AppState.currentState === "active") return;
      const alert = alertForFrame(action.type, action.payload);
      if (alert !== undefined) void presentLocalAlert(alert);
    };

    const realtime = new RealtimeClient({
      socket: new NativeSocket(),
      session,
      url: clientSocketUrl(serverUrl),
      network,
      dispatch: onRealtimeAction,
    });

    services.current = {
      session,
      network,
      api,
      mobile,
      realtime,
      voice,
      chat: new ChatController({
        mobile,
        api,
        realtime,
        session,
        dispatch,
        onChange: setChat,
        onReply: (text) => {
          void voice.speak(text);
        },
      }),
    };
  }

  const { session, api, mobile, realtime, voice, chat: controller, network } = services.current;

  /** Registers or binds this phone, then reads what the core thinks of it. */
  const attachDevice = useCallback(async (): Promise<DeviceTrust> => {
    const device = await session.ensureDevice({
      name: DEVICE_NAME,
      type: Platform.OS === "ios" ? "IPHONE" : "ANDROID",
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
      role: "CLIENT",
    });

    let trust: string | undefined = device.trust;
    if (trust === undefined) {
      // Restored session: the id is cached but its approval may have changed.
      const devices = await api.listDevices();
      trust = devices.find((candidate) => candidate.id === device.deviceId)?.trust;
    }

    const next: DeviceTrust =
      trust === "TRUSTED"
        ? "trusted"
        : trust === "PENDING"
          ? "pending"
          : trust === "REVOKED"
            ? "revoked"
            : "unknown";
    setDeviceTrust(next);
    return next;
  }, [session, api]);

  /** The core refuses the channel to an unapproved device; dialing it would only loop. */
  const connectIfAllowed = useCallback(async () => {
    const trust = await attachDevice();
    if (trust === "pending" || trust === "revoked") return;
    await realtime.start();
  }, [attachDevice, realtime]);

  // Session restoration on mount
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [restored, mode, speak] = await Promise.all([
        session.restore().catch(() => false),
        readPreference("nexus.sendMode"),
        readPreference("nexus.speakReplies"),
      ]);
      if (cancelled) return;

      if (mode === "chat" || mode === "action" || mode === "mission") setSendModeState(mode);
      voice.setSpeakReplies(speak === "true");
      setAuthenticated(restored);
      setReady(true);

      if (restored) await connectIfAllowed().catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      realtime.stop("screen unmounted");
      network.dispose();
    };
  }, [session, realtime, voice, network, connectIfAllowed]);

  // An unapproved phone waits. Approval happens elsewhere, so it has to look.
  useEffect(() => {
    if (!authenticated || deviceTrust !== "pending") return;
    const timer = setInterval(() => {
      void connectIfAllowed().catch(() => undefined);
    }, APPROVAL_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [authenticated, deviceTrust, connectIfAllowed]);

  /** Everything the channel could not tell us while we were away. */
  const resynchronize = useCallback(() => {
    void resyncTasks({ api, state: stateRef.current, dispatch }).catch(() => undefined);
    void controller.refresh();
    void api
      .listNotifications()
      .then((notifications) => {
        dispatch({ kind: "hydrateNotifications", notifications });
      })
      .catch(() => undefined);
  }, [api, controller]);

  useEffect(() => {
    if (state.connection !== "connected") return;
    resynchronize();
    // "Retrying in 4 s" must not outlive the outage it describes.
    if (stateRef.current.lastError?.code === "CONNECTION_LOST") dispatch({ kind: "clearError" });
  }, [state.connection, resynchronize]);

  // Returning to the foreground: the OS may have killed the socket silently.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status !== "active" || !session.isAuthenticated) return;
      if (stateRef.current.connection === "connected") {
        resynchronize();
        return;
      }
      realtime.stop("returning to foreground");
      void connectIfAllowed().catch(() => undefined);
    });
    return () => {
      subscription.remove();
    };
  }, [session, realtime, connectIfAllowed, resynchronize]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await session.login(email, password);
      setAuthenticated(true);
      await connectIfAllowed();
    },
    [session, connectIfAllowed],
  );

  const signOut = useCallback(async () => {
    clearResourceCache();
    realtime.stop("sign out");
    controller.newConversation();
    await session.logout();
    setAuthenticated(false);
    setDeviceTrust("unknown");
    dispatch({ kind: "reset" });
  }, [session, realtime, controller]);

  const send = useCallback(
    (text: string) => controller.send(text, sendMode),
    [controller, sendMode],
  );

  const setSendMode = useCallback((mode: SendMode) => {
    setSendModeState(mode);
    void writePreference("nexus.sendMode", mode);
  }, []);

  const newConversation = useCallback(() => {
    controller.newConversation();
  }, [controller]);

  const openConversation = useCallback(
    (conversationId: string) => controller.openConversation(conversationId),
    [controller],
  );

  const reportError = useCallback((cause: unknown) => {
    dispatch({
      kind: "error",
      code: "ACTION_FAILED",
      message: failureMessage(cause),
      at: new Date().toISOString(),
    });
  }, []);

  const answerConfirmation = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      dispatch({ kind: "confirmationAnswered", confirmationId: id });
      await realtime.respondToConfirmation(id, decision).catch(reportError);
    },
    [realtime, reportError],
  );

  const answerRunConfirmation = useCallback(
    (decision: "approved" | "rejected") => controller.answerConfirmation(decision),
    [controller],
  );

  const stopRun = useCallback(() => controller.stop(), [controller]);

  const cancelTask = useCallback(
    async (taskId: string) => {
      await realtime.cancelTask(taskId).catch(reportError);
    },
    [realtime, reportError],
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

  const refreshDeviceTrust = useCallback(async () => {
    await connectIfAllowed();
  }, [connectIfAllowed]);

  const markNotificationRead = useCallback(
    async (id: string) => {
      dispatch({ kind: "notificationRead", notificationId: id, at: new Date().toISOString() });
      await api.markNotificationRead(id).catch(() => undefined);
    },
    [api],
  );

  const hydrateNotifications = useCallback((notifications: NotificationView[]) => {
    dispatch({ kind: "hydrateNotifications", notifications });
  }, []);

  const setSpeakReplies = useCallback(
    (enabled: boolean) => {
      voice.setSpeakReplies(enabled);
      if (!enabled) void voice.stopSpeaking();
      void writePreference("nexus.speakReplies", String(enabled));
    },
    [voice],
  );

  const dismissError = useCallback(() => {
    dispatch({ kind: "clearError" });
  }, []);

  const value = useMemo<NexusContextValue>(
    () => ({
      serverUrl,
      state,
      chat,
      session,
      api,
      mobile,
      realtime,
      voice,
      voiceState,
      partialTranscript,
      ready,
      authenticated,
      deviceTrust,
      devicePending: deviceTrust === "pending",
      sendMode,
      signIn,
      signOut,
      send,
      setSendMode,
      newConversation,
      openConversation,
      answerConfirmation,
      answerRunConfirmation,
      stopRun,
      cancelTask,
      refreshDevices,
      refreshDeviceTrust,
      markNotificationRead,
      hydrateNotifications,
      setSpeakReplies,
      reportError,
      dismissError,
    }),
    [
      serverUrl,
      state,
      chat,
      session,
      api,
      mobile,
      realtime,
      voice,
      voiceState,
      partialTranscript,
      ready,
      authenticated,
      deviceTrust,
      sendMode,
      signIn,
      signOut,
      send,
      setSendMode,
      newConversation,
      openConversation,
      answerConfirmation,
      answerRunConfirmation,
      stopRun,
      cancelTask,
      refreshDevices,
      refreshDeviceTrust,
      markNotificationRead,
      hydrateNotifications,
      setSpeakReplies,
      reportError,
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
