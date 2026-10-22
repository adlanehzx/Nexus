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
import type { ReactNode } from "react";
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
  type ApiConversation,
  type ClientState,
  type MessageView,
  type VoiceState,
} from "@nexus/client-core";
import {
  BrowserNetworkMonitor,
  BrowserSocket,
  FetchHttpClient,
  WebSpeechToText,
  WebTextToSpeech,
} from "./platform.js";
import { detectShell } from "./shells.js";
import type { DesktopShell } from "./shell.js";
import { localWorkerStatus, remoteWorkers, type LocalWorkerStatus } from "./worker-status.js";
import { mergeHistory } from "./history.js";
import { taskRequestBody, type TaskDraft } from "./tasks.js";

/**
 * NEXUS context for Windows desktop client.
 *
 * Uses `@nexus/client-core` for sessions, reconnection, state store, and voice pipeline.
 * Contains no direct system execution or local daemon access.
 */

/**
 * Core backend address.
 */
function backendUrl(): string {
  return import.meta.env.VITE_NEXUS_URL ?? "https://nexus.local";
}

export type Screen =
  "chat" | "tasks" | "devices" | "notifications" | "memory" | "worker" | "settings";

export interface NexusContextValue {
  state: ClientState;
  shell: DesktopShell;
  session: SessionManager;
  api: ApiClient;
  realtime: RealtimeClient;
  voice: VoicePipeline;
  voiceState: VoiceState;
  partialTranscript: string;
  voiceAvailable: boolean;

  ready: boolean;
  authenticated: boolean;
  /** `null` until a device is bound to this window. */
  boundDeviceId: string | null;

  /** Status of worker installed on this host, as seen by the core. */
  worker: LocalWorkerStatus;
  /** Remote workers across the fleet. */
  fleet: ReturnType<typeof remoteWorkers>;

  conversations: ApiConversation[];
  activeConversationId: string | null;
  /** Merged history and live stream. */
  timeline: MessageView[];

  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  bindDevice: (deviceId: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  openConversation: (conversationId: string | null) => Promise<void>;
  submitTask: (draft: TaskDraft) => Promise<void>;
  answerConfirmation: (id: string, decision: "approved" | "rejected") => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  dismissError: () => void;
}

const NexusContext = createContext<NexusContextValue | undefined>(undefined);

interface Services {
  shell: DesktopShell;
  session: SessionManager;
  api: ApiClient;
  realtime: RealtimeClient;
  voice: VoicePipeline;
}

export function NexusProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [boundDeviceId, setBoundDeviceId] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [localWorkerId, setLocalWorkerId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<MessageView[]>([]);

  /**
   * Services are constructed once per session lifecycle.
   */
  const services = useRef<Services | null>(null);

  if (services.current === null) {
    const shell = detectShell();
    const url = backendHttpUrl(backendUrl());

    const session = new SessionManager({
      http: new FetchHttpClient(url),
      storage: shell.storage,
      onSignedOut: () => {
        setAuthenticated(false);
        dispatch({ kind: "reset" });
      },
    });

    services.current = {
      shell,
      session,
      api: new ApiClient(session),
      realtime: new RealtimeClient({
        socket: new BrowserSocket(),
        session,
        url: clientSocketUrl(backendUrl()),
        network: new BrowserNetworkMonitor(),
        dispatch,
      }),
      voice: new VoicePipeline({
        speechToText: new WebSpeechToText(),
        textToSpeech: new WebTextToSpeech(),
        locale: "en-US",
        onStateChange: setVoiceState,
        onPartial: setPartialTranscript,
      }),
    };
  }

  const { shell, session, api, realtime, voice } = services.current;

  // ── Startup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [restored, workerId, micAvailable] = await Promise.all([
        session.restore().catch(() => false),
        shell.localWorkerDeviceId().catch(() => null),
        voice.isSpeechAvailable().catch(() => false),
      ]);
      if (cancelled) return;

      setLocalWorkerId(workerId);
      setVoiceAvailable(micAvailable);
      setAuthenticated(restored);
      setBoundDeviceId(session.deviceId);
      setReady(true);

      if (restored && session.deviceId === null && workerId !== null) {
        await session.bindDevice(workerId).catch(() => undefined);
        if (!cancelled) setBoundDeviceId(workerId);
      }

      if (restored) await realtime.start().catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      realtime.stop("window closed");
    };
  }, [session, realtime, shell, voice]);

  // ── System notifications ─────────────────────────────────────────────────

  const lastNotifiedRef = useRef<string | null>(null);

  useEffect(() => {
    const latest = state.notifications[0];
    if (latest === undefined || latest.id === lastNotifiedRef.current) return;

    lastNotifiedRef.current = latest.id;
    void shell
      .notify({ title: latest.title, body: latest.body, severity: latest.severity })
      .catch(() => undefined);
  }, [state.notifications, shell]);

  // ── Actions ──────────────────────────────────────────────────────────────

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

  const loadConversations = useCallback(async () => {
    const list = await api.listConversations().catch(() => []);
    setConversations(list);
  }, [api]);

  /**
   * Resync active tasks whenever connection is restored.
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

      if (session.deviceId === null) {
        if (localWorkerId !== null) {
          await session.bindDevice(localWorkerId);
          setBoundDeviceId(localWorkerId);
        } else {
          const machineName = await shell.machineName();
          const device = await session.ensureDevice({
            name: `${machineName} (client)`,
            type: "WINDOWS_PC",
            platform: "WINDOWS",
            role: "CLIENT",
          });
          setBoundDeviceId(device.deviceId);
        }
      }

      await realtime.start();
      await Promise.all([refreshDevices(), loadConversations()]);
    },
    [session, realtime, localWorkerId, refreshDevices, loadConversations, shell],
  );

  const signOut = useCallback(async () => {
    realtime.stop("sign out");
    await session.logout();
    setAuthenticated(false);
    setConversations([]);
    setHistory([]);
    dispatch({ kind: "reset" });
  }, [session, realtime]);

  const bindDevice = useCallback(
    async (deviceId: string) => {
      await session.bindDevice(deviceId);
      setBoundDeviceId(deviceId);
      realtime.stop("device changed");
      await realtime.start();
    },
    [session, realtime],
  );

  const openConversation = useCallback(
    async (conversationId: string | null) => {
      setActiveConversationId(conversationId);

      if (conversationId === null) {
        setHistory([]);
        return;
      }

      const messages = await api.listMessages(conversationId).catch(() => []);
      setHistory(mergeHistory([], messages));
    },
    [api],
  );

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

      const result = await realtime.sendMessage({
        conversationId: activeConversationId,
        text: trimmed,
      });

      if (activeConversationId === null) {
        setActiveConversationId(result.conversationId);
        await loadConversations();
      }

      if (session.deviceId === null) {
        throw new Error("Bind this window to a device before requesting an action.");
      }

      await api.instruct({
        instruction: trimmed,
        originClientDeviceId: session.deviceId,
        conversationId: result.conversationId,
      });
    },
    [realtime, api, session, activeConversationId, loadConversations],
  );

  const submitTask = useCallback(
    async (draft: TaskDraft) => {
      if (session.deviceId === null) {
        throw new Error("Bind this window to a device before creating a task.");
      }

      await api.createTask(taskRequestBody(draft, session.deviceId));
    },
    [api, session],
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

  // ── Derived state ────────────────────────────────────────────────────────

  const worker = useMemo(
    () => localWorkerStatus({ localWorkerDeviceId: localWorkerId, devices: state.devices }),
    [localWorkerId, state.devices],
  );

  const fleet = useMemo(
    () => remoteWorkers({ localWorkerDeviceId: localWorkerId, devices: state.devices }),
    [localWorkerId, state.devices],
  );

  const timeline = useMemo(() => mergeHistory(state.messages, history), [state.messages, history]);

  const value = useMemo<NexusContextValue>(
    () => ({
      state,
      shell,
      session,
      api,
      realtime,
      voice,
      voiceState,
      partialTranscript,
      voiceAvailable,
      ready,
      authenticated,
      boundDeviceId,
      worker,
      fleet,
      conversations,
      activeConversationId,
      timeline,
      signIn,
      signOut,
      bindDevice,
      send,
      openConversation,
      submitTask,
      answerConfirmation,
      cancelTask,
      refreshDevices,
      markNotificationRead,
      dismissError,
    }),
    [
      state,
      shell,
      session,
      api,
      realtime,
      voice,
      voiceState,
      partialTranscript,
      voiceAvailable,
      ready,
      authenticated,
      boundDeviceId,
      worker,
      fleet,
      conversations,
      activeConversationId,
      timeline,
      signIn,
      signOut,
      bindDevice,
      send,
      openConversation,
      submitTask,
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
 */
export function useNexus(): NexusContextValue {
  const value = useContext(NexusContext);
  if (value === undefined) {
    throw new Error("useNexus must be used within <NexusProvider>");
  }
  return value;
}
