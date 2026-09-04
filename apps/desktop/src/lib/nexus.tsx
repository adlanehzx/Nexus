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
 * Le contexte NEXUS, côté poste Windows.
 *
 * Même cœur que l'iPhone, mot pour mot : `@nexus/client-core` fournit la
 * session, la reconnexion, le magasin d'état et le pipeline vocal. Ce fichier
 * ne fait que du câblage et de la présentation à React.
 *
 * **Ce que ce fichier ne contient pas** mérite d'être dit, parce que la machine
 * qui l'exécute est aussi un exécutant NEXUS : aucun appel système, aucune
 * exécution, aucun accès au démon worker autre que la lecture de son
 * identifiant public. Quand l'utilisateur demande quelque chose au poste depuis
 * cette fenêtre, la demande part sur le réseau, remonte au cœur, redescend par
 * le canal worker, et revient. Le trajet est absurde à l'échelle d'une seule
 * machine ; il est ce qui garantit qu'aucune fenêtre ne devient un shell.
 */

/**
 * Adresse du cœur.
 *
 * Remplacée à la compilation par Vite. Ce n'est pas un secret — et c'est
 * précisément pour cela qu'elle peut figurer dans le paquet : **aucun secret du
 * serveur n'est embarqué**. Un exécutable de bureau se désassemble aussi bien
 * qu'une application mobile.
 */
function backendUrl(): string {
  const injected = (import.meta as { env?: { VITE_NEXUS_URL?: string } }).env;
  return injected?.VITE_NEXUS_URL ?? "https://nexus.local";
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
  /** `null` tant qu'aucun appareil n'est rattaché à cette fenêtre. */
  boundDeviceId: string | null;

  /** État de l'exécutant installé sur ce poste, tel que le cœur le voit. */
  worker: LocalWorkerStatus;
  /** Les autres exécutants — poste fixe, Redmi. Affichés, jamais pilotés. */
  fleet: ReturnType<typeof remoteWorkers>;

  conversations: ApiConversation[];
  activeConversationId: string | null;
  /** Historique et direct déjà fusionnés, prêts à afficher. */
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
   * Les services sont construits **une fois**.
   *
   * `useRef` et non `useMemo` : React se réserve le droit de rejouer un
   * `useMemo`, et rouvrir une socket à chaque rendu ferait battre la connexion.
   */
  const services = useRef<Services | null>(null);

  if (services.current === null) {
    const shell = detectShell();
    // Validée plutôt que concaténée : une adresse distante en clair
    // transporterait le jeton d'accès dans la première trame du canal.
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
        locale: "fr-FR",
        onStateChange: setVoiceState,
        onPartial: setPartialTranscript,
      }),
    };
  }

  const { shell, session, api, realtime, voice } = services.current;

  // ── Démarrage ───────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [restored, workerId, micro] = await Promise.all([
        session.restore().catch(() => false),
        shell.localWorkerDeviceId().catch(() => null),
        voice.isSpeechAvailable().catch(() => false),
      ]);
      if (cancelled) return;

      setLocalWorkerId(workerId);
      setVoiceAvailable(micro);
      setAuthenticated(restored);
      setBoundDeviceId(session.deviceId);
      setReady(true);

      // Le démon a déjà appairé cette machine : la fenêtre reprend le même
      // identifiant plutôt que d'en créer un second, qui apparaîtrait comme un
      // appareil fantôme dans la liste de l'utilisateur.
      if (restored && session.deviceId === null && workerId !== null) {
        await session.bindDevice(workerId).catch(() => undefined);
        if (!cancelled) setBoundDeviceId(workerId);
      }

      if (restored) await realtime.start().catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      realtime.stop("fenêtre fermée");
    };
  }, [session, realtime, shell, voice]);

  // ── Notifications du système ────────────────────────────────────────────

  const lastNotifiedRef = useRef<string | null>(null);

  useEffect(() => {
    const latest = state.notifications[0];
    if (latest === undefined || latest.id === lastNotifiedRef.current) return;

    lastNotifiedRef.current = latest.id;
    // Une notification est **produite au centre** et poussée aux deux clients.
    // Cette fenêtre ne fait que la relayer au système ; elle n'en fabrique
    // aucune, sans quoi l'iPhone et le portable en afficheraient de
    // différentes pour le même événement.
    void shell
      .notify({ title: latest.title, body: latest.body, severity: latest.severity })
      .catch(() => undefined);
  }, [state.notifications, shell]);

  // ── Actions ─────────────────────────────────────────────────────────────

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
   * Rattrapage à chaque retour de connexion.
   *
   * Le canal ne rejoue rien : une tâche achevée pendant que le poste dormait
   * resterait affichée « en cours », définitivement. On relit donc auprès du
   * cœur l'état des tâches qu'on croit encore actives.
   *
   * `state.tasks` n'est volontairement pas dans les dépendances : l'effet se
   * déclenche sur le **passage** à « connecté », sinon chaque trame de
   * progression relancerait un rattrapage.
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

      if (session.deviceId === null && localWorkerId !== null) {
        await session.bindDevice(localWorkerId);
        setBoundDeviceId(localWorkerId);
      }

      await realtime.start();
      await Promise.all([refreshDevices(), loadConversations()]);
    },
    [session, realtime, localWorkerId, refreshDevices, loadConversations],
  );

  const signOut = useCallback(async () => {
    realtime.stop("déconnexion");
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
      // La poignée de main porte l'appareil : il faut la refaire pour que le
      // cœur sache d'où l'on parle désormais.
      realtime.stop("changement d'appareil");
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

      // Le message s'affiche immédiatement : attendre l'accusé donnerait
      // l'impression que la fenêtre n'a rien reçu.
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

      // Deux gestes, et l'ordre compte. Le message est d'abord **inscrit dans
      // la conversation** — c'est la trace, elle appartient à l'historique.
      const result = await realtime.sendMessage({
        conversationId: activeConversationId,
        text: trimmed,
      });

      if (activeConversationId === null) {
        setActiveConversationId(result.conversationId);
        await loadConversations();
      }

      // Puis l'instruction part au cœur, qui planifie, autorise et exécute. Le
      // client ne planifie pas : il transmet la phrase. Sans cet appel, le
      // message serait archivé et rien ne se passerait.
      if (session.deviceId === null) {
        throw new Error("Rattachez cette fenêtre à un appareil avant de demander une action.");
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
        throw new Error("Rattachez cette fenêtre à un appareil avant de lancer une tâche.");
      }

      // Le corps ne nomme aucun exécutant : il déclare des capacités, et le
      // cœur choisit. C'est ce qui permet de « piloter » le poste fixe ou le
      // Redmi depuis ici sans jamais leur parler.
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

  // ── Dérivations ─────────────────────────────────────────────────────────

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
 * Accès au contexte.
 *
 * Lève hors du fournisseur : un écran monté au mauvais endroit doit échouer
 * bruyamment, pas afficher un état vide qu'on mettra une heure à diagnostiquer.
 */
export function useNexus(): NexusContextValue {
  const value = useContext(NexusContext);
  if (value === undefined) {
    throw new Error("useNexus doit être utilisé à l'intérieur de <NexusProvider>");
  }
  return value;
}
