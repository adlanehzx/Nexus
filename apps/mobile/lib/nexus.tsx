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
import {
  ExpoTextToSpeech,
  FetchHttpClient,
  KeychainStorage,
  NativeSocket,
  OptimisticNetworkMonitor,
  UnavailableSpeechToText,
} from "./platform.js";

/**
 * Le contexte NEXUS.
 *
 * Un seul endroit assemble le cœur client et les implémentations iOS ; les
 * écrans ne construisent rien, ils consomment. C'est ce qui permet de changer un
 * port — la reconnaissance vocale, par exemple — sans toucher à un seul écran.
 *
 * Les décisions restent dans `@nexus/client-core`, qui est testé. Ce fichier ne
 * fait que du câblage et de la présentation d'état à React.
 */

/**
 * Adresse du cœur.
 *
 * `EXPO_PUBLIC_*` est remplacée à la compilation par Expo — ce n'est pas un
 * secret, et c'est bien pour cela qu'elle peut y figurer. Aucun secret serveur
 * n'est embarqué : une application mobile est décompilable.
 */
declare const process: { env: Record<string, string | undefined> };

// Validées plutôt que concaténées : une adresse distante en clair transporterait
// le jeton d'accès dans la première trame du canal. Voir `transport.ts`.
const BACKEND_URL = backendHttpUrl(process.env.EXPO_PUBLIC_NEXUS_URL ?? "https://nexus.local");
const SOCKET_URL = clientSocketUrl(process.env.EXPO_PUBLIC_NEXUS_URL ?? "https://nexus.local");

export interface NexusContextValue {
  state: ClientState;
  session: SessionManager;
  api: ApiClient;
  realtime: RealtimeClient;
  voice: VoicePipeline;
  voiceState: VoiceState;
  /** Transcription en cours, affichée pendant que l'utilisateur parle. */
  partialTranscript: string;
  ready: boolean;
  authenticated: boolean;

  // Déclarés comme propriétés-fonctions et non comme méthodes : ce sont des
  // fermetures `useCallback`, qui ne dépendent d'aucun `this`. La forme méthode
  // laisserait croire l'inverse et interdirait de les déstructurer.
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

/** Ce que le fournisseur construit une fois pour toutes. */
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

  /**
   * Les services sont construits une fois.
   *
   * `useRef` plutôt que `useMemo` : React peut réexécuter un `useMemo` sans
   * préavis, et rouvrir une socket à chaque rendu serait catastrophique.
   */
  const services = useRef<Services | null>(null);

  if (services.current === null) {
    const network = new OptimisticNetworkMonitor();
    const session = new SessionManager({
      http: new FetchHttpClient(BACKEND_URL),
      storage: new KeychainStorage(),
      onSignedOut: () => {
        setAuthenticated(false);
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
        speechToText: new UnavailableSpeechToText(),
        textToSpeech: new ExpoTextToSpeech(),
        locale: "fr-FR",
        onStateChange: setVoiceState,
        onPartial: setPartialTranscript,
      }),
    };
  }

  const { session, api, realtime, voice } = services.current;

  // Reprise de session au lancement : si le trousseau contient des jetons,
  // l'utilisateur ne repasse pas par l'écran de connexion.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await session.restore().catch(() => false);
      if (cancelled) return;

      setAuthenticated(restored);
      setReady(true);

      if (restored) await realtime.start().catch(() => undefined);
    })();

    return () => {
      cancelled = true;
      realtime.stop("écran quitté");
    };
  }, [session, realtime]);

  /**
   * Rattrapage à chaque retour de connexion.
   *
   * Le canal ne rejoue rien : une tâche achevée pendant que le téléphone était
   * dans le métro resterait affichée « en cours », définitivement. On relit donc
   * auprès du cœur l'état des tâches qu'on croit encore actives.
   *
   * `state.tasks` n'est volontairement pas dans les dépendances : l'effet se
   * déclenche sur le **passage** à « connecté », pas à chaque changement de
   * tâche, sinon chaque trame de progression relancerait un rattrapage.
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
      await realtime.start();
    },
    [session, realtime],
  );

  const signOut = useCallback(async () => {
    realtime.stop("déconnexion");
    await session.logout();
    setAuthenticated(false);
    dispatch({ kind: "reset" });
  }, [session, realtime]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      // Le message de l'utilisateur s'affiche tout de suite : attendre l'accusé
      // donnerait l'impression que l'application n'a rien reçu.
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
      const { conversationId } = await realtime.sendMessage({
        conversationId: null,
        text: trimmed,
      });

      // Puis l'instruction part au cœur, qui planifie, autorise et exécute.
      // Le client ne planifie pas : il transmet la phrase. Sans cet appel, le
      // message serait archivé et rien ne se passerait.
      if (session.deviceId === null) {
        throw new Error(
          "Cet iPhone n'est pas encore enregistré auprès de NEXUS. Ouvrez les réglages pour l'appairer.",
        );
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
      // L'état local passe d'abord : la carte disparaît, ce qui empêche un
      // second appui pendant l'aller-retour.
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
 * Accès au contexte.
 *
 * Lève hors du fournisseur plutôt que de rendre `undefined` : un écran monté au
 * mauvais endroit doit échouer bruyamment, pas afficher un état vide qu'on
 * mettra une heure à diagnostiquer.
 */
export function useNexus(): NexusContextValue {
  const value = useContext(NexusContext);
  if (value === undefined) {
    throw new Error("useNexus doit être utilisé à l'intérieur de <NexusProvider>");
  }
  return value;
}
