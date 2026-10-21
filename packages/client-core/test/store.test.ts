import { describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT, type ServerToClientType } from "@nexus/protocol";
import {
  activeTasks,
  canInteract,
  finishedTasks,
  initialState,
  pendingConfirmations,
  reduce,
  unreadNotifications,
  type ClientState,
} from "../src/store.js";
import { VoicePipeline } from "../src/voice.js";
import { FakeSpeechToText, FakeTextToSpeech, TestTimers } from "./fixtures.js";

/**
 * Le réducteur et le pipeline vocal.
 *
 * Le réducteur est pur : une trame entre, un état sort. C'est ce qui permet de
 * décrire précisément ce que l'écran doit montrer, sans monter d'interface.
 */

function apply(state: ClientState, type: ServerToClientType, payload: Record<string, unknown>) {
  return reduce(state, {
    kind: "server",
    type,
    payload: { ts: "2026-09-02T12:00:00.000Z", ...payload },
  });
}

describe("flux de la réponse", () => {
  it("crée le message au premier fragment", () => {
    // Attendre un « début de flux » explicite ajouterait un aller-retour, et un
    // fragment perdu laisserait le message invisible.
    const state = apply(initialState, SERVER_TO_CLIENT.messageDelta, {
      conversationId: "c1",
      messageId: "m1",
      delta: "Bon",
      done: false,
    });

    expect(state.messages[0]).toMatchObject({ id: "m1", content: "Bon", streaming: true });
  });

  it("concatène les fragments suivants", () => {
    let state = initialState;
    for (const delta of ["Bon", "jour ", "Alex"]) {
      state = apply(state, SERVER_TO_CLIENT.messageDelta, {
        conversationId: "c1",
        messageId: "m1",
        delta,
        done: false,
      });
    }

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("Bonjour Alex");
  });

  it("clôt le flux au dernier fragment", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.messageDelta, {
      messageId: "m1",
      delta: "Bonjour",
      done: false,
    });
    state = apply(state, SERVER_TO_CLIENT.messageDelta, {
      messageId: "m1",
      delta: ".",
      done: true,
    });

    expect(state.messages[0]).toMatchObject({ content: "Bonjour.", streaming: false });
  });

  it("garde les messages de l'utilisateur et de l'assistant séparés", () => {
    let state = reduce(initialState, {
      kind: "localMessage",
      message: {
        id: "u1",
        role: "user",
        content: "Ouvre Spotify",
        streaming: false,
        createdAt: "2026-09-02T12:00:00.000Z",
        originClientDeviceId: "device-iphone",
      },
    });
    state = apply(state, SERVER_TO_CLIENT.messageDelta, {
      messageId: "a1",
      delta: "Voilà.",
      done: true,
    });

    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("tâches", () => {
  it("crée une tâche", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Lancer les tests",
      stepCount: 3,
      originClientDeviceId: "device-iphone",
    });

    expect(state.tasks[0]).toMatchObject({
      id: "t1",
      title: "Lancer les tests",
      status: "pending",
      stepCount: 3,
      originClientDeviceId: "device-iphone",
    });
  });

  it("suit la progression", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Tests",
      stepCount: 2,
    });
    state = apply(state, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s1",
      percent: 50,
      label: "Clonage du dépôt",
    });

    expect(state.tasks[0]).toMatchObject({
      status: "running",
      percent: 50,
      label: "Clonage du dépôt",
    });
  });

  it("marque la réussite", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Tests",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskCompleted, {
      taskId: "t1",
      status: "succeeded",
      durationMs: 4_200,
    });

    expect(state.tasks[0]).toMatchObject({ status: "succeeded", percent: 100, durationMs: 4_200 });
  });

  it("distingue une réussite partielle", () => {
    // « Rien n'a marché » et « deux étapes sur trois ont marché » n'appellent
    // pas la même suite.
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Tests",
      stepCount: 3,
    });
    state = apply(state, SERVER_TO_CLIENT.taskCompleted, {
      taskId: "t1",
      status: "partial",
      durationMs: 100,
    });

    expect(state.tasks[0]?.status).toBe("partial");
  });

  it("retient l'erreur d'un échec", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Tests",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskFailed, {
      taskId: "t1",
      code: "PATH_NOT_ALLOWED",
      message: "Ce chemin est en dehors des dossiers autorisés.",
    });

    expect(state.tasks[0]).toMatchObject({
      status: "failed",
      error: { code: "PATH_NOT_ALLOWED" },
    });
  });

  it("retient l'exécutant annoncé par la progression", () => {
    // Sans ce champ, la vue d'une tâche reste anonyme : « en cours » sans dire
    // où, ce qui n'apprend rien. C'est la différence entre « ça travaille » et
    // « le poste fixe compile pendant que je regarde mon téléphone ».
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Compiler",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s1",
      deviceId: "device-fixe",
      percent: 40,
      label: null,
    });

    expect(state.tasks[0]?.workerDeviceId).toBe("device-fixe");
  });

  it("n'efface pas un exécutant connu avec une progression anonyme", () => {
    // Une étape refusée à l'autorisation n'atteint aucun exécutant et rapporte
    // `null`. Le laisser écraser effacerait ce qui était affiché pour l'étape
    // précédente, sous les yeux de l'utilisateur.
    let state = apply(initialState, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s1",
      deviceId: "device-portable",
      percent: 30,
      label: null,
    });
    state = apply(state, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s2",
      deviceId: null,
      percent: 60,
      label: null,
    });

    expect(state.tasks[0]?.workerDeviceId).toBe("device-portable");
  });

  it("fait apparaître une tâche connue seulement par sa progression", () => {
    // L'iPhone était éteint quand elle a démarré : elle doit tout de même
    // apparaître au rallumage.
    const state = apply(initialState, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t-inconnue",
      stepId: "s1",
      percent: 30,
      label: "en cours",
    });

    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.status).toBe("running");
  });

  it("sépare les tâches actives des terminées", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "En cours",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t2",
      title: "Finie",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskCompleted, {
      taskId: "t2",
      status: "succeeded",
      durationMs: 1,
    });

    expect(activeTasks(state).map((t) => t.id)).toEqual(["t1"]);
    expect(finishedTasks(state).map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("cartes d'outil", () => {
  it("suit un appel d'outil du début à la fin", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.toolStarted, {
      runId: "r1",
      callId: "c1",
      tool: "device.terminal.execute",
      summary: "Lancer les tests sur le poste fixe",
      riskLevel: "HIGH",
    });
    expect(state.toolCalls[0]).toMatchObject({ status: "running", riskLevel: "HIGH" });

    state = apply(state, SERVER_TO_CLIENT.toolProgress, {
      runId: "r1",
      callId: "c1",
      percent: 60,
      label: "compilation",
    });
    expect(state.toolCalls[0]).toMatchObject({ percent: 60, label: "compilation" });

    state = apply(state, SERVER_TO_CLIENT.toolCompleted, {
      runId: "r1",
      callId: "c1",
      tool: "device.terminal.execute",
      ok: true,
      summary: "240 tests réussis",
      durationMs: 12_000,
    });
    expect(state.toolCalls[0]).toMatchObject({ status: "succeeded", percent: 100 });
  });
});

describe("confirmations", () => {
  it("ajoute une demande", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.confirmationRequired, {
      confirmationId: "k1",
      taskId: "t1",
      capability: "terminal.execute",
      action: "Exécuter une commande sur le poste fixe",
      description: "pnpm test",
      riskLevel: "HIGH",
      expiresAt: "2026-09-02T12:10:00.000Z",
    });

    expect(pendingConfirmations(state)).toHaveLength(1);
    expect(state.confirmations[0]).toMatchObject({ riskLevel: "HIGH", answered: false });
  });

  it("ne duplique pas une demande rejouée après reconnexion", () => {
    const payload = {
      confirmationId: "k1",
      action: "x",
      description: "y",
      riskLevel: "HIGH",
      expiresAt: "2026-09-02T12:10:00.000Z",
    };

    let state = apply(initialState, SERVER_TO_CLIENT.confirmationRequired, payload);
    state = apply(state, SERVER_TO_CLIENT.confirmationRequired, payload);

    expect(state.confirmations).toHaveLength(1);
  });

  it("marque la demande comme tranchée", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.confirmationRequired, {
      confirmationId: "k1",
      action: "x",
      description: "y",
      riskLevel: "HIGH",
      expiresAt: "2026-09-02T12:10:00.000Z",
    });
    state = reduce(state, { kind: "confirmationAnswered", confirmationId: "k1" });

    // La carte disparaît de l'écran : un second appui ne renverra rien.
    expect(pendingConfirmations(state)).toHaveLength(0);
    expect(state.confirmations[0]?.answered).toBe(true);
  });
});

describe("notifications", () => {
  it("ajoute la plus récente en tête", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n1",
      title: "Première",
      body: "x",
      severity: "info",
    });
    state = apply(state, SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n2",
      title: "Seconde",
      body: "y",
      severity: "error",
    });

    expect(state.notifications.map((n) => n.title)).toEqual(["Seconde", "Première"]);
  });

  it("ne duplique pas une notification rejouée", () => {
    const payload = { notificationId: "n1", title: "x", body: "y", severity: "info" };
    let state = apply(initialState, SERVER_TO_CLIENT.notificationCreated, payload);
    state = apply(state, SERVER_TO_CLIENT.notificationCreated, payload);

    expect(state.notifications).toHaveLength(1);
  });

  it("marque comme lue", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n1",
      title: "x",
      body: "y",
      severity: "warning",
    });
    expect(unreadNotifications(state)).toHaveLength(1);

    state = reduce(state, {
      kind: "notificationRead",
      notificationId: "n1",
      at: "2026-09-02T12:05:00.000Z",
    });
    expect(unreadNotifications(state)).toHaveLength(0);
  });
});

describe("appareils", () => {
  it("ajoute un appareil inconnu", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.deviceUpdated, {
      deviceId: "d1",
      deviceName: "Poste fixe",
      status: "ONLINE",
      role: "WORKER",
      capabilities: ["terminal.execute"],
    });

    expect(state.devices[0]).toMatchObject({ id: "d1", name: "Poste fixe", status: "ONLINE" });
  });

  it("met à jour sans écraser ce que la trame ne dit pas", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.deviceUpdated, {
      deviceId: "d1",
      deviceName: "Poste fixe",
      status: "ONLINE",
      role: "WORKER",
      capabilities: ["terminal.execute"],
    });
    state = apply(state, SERVER_TO_CLIENT.deviceUpdated, { deviceId: "d1", status: "OFFLINE" });

    expect(state.devices[0]).toMatchObject({
      name: "Poste fixe",
      status: "OFFLINE",
      capabilities: ["terminal.execute"],
    });
  });
});

describe("état de connexion", () => {
  it("n'autorise l'interaction que connecté et en ligne", () => {
    let state = reduce(initialState, { kind: "connection", state: "connected" });
    expect(canInteract(state)).toBe(true);

    state = reduce(state, { kind: "network", online: false });
    expect(canInteract(state)).toBe(false);
  });

  it("efface l'erreur affichée", () => {
    let state = reduce(initialState, {
      kind: "error",
      code: "CONNECTION_LOST",
      message: "Connexion perdue",
      at: "2026-09-02T12:00:00.000Z",
    });
    expect(state.lastError).not.toBeNull();

    state = reduce(state, { kind: "clearError" });
    expect(state.lastError).toBeNull();
  });

  it("laisse l'état inchangé sur une trame sans effet", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.agentStarted, {
      runId: "r1",
      conversationId: "c1",
    });
    expect(state).toEqual(initialState);
  });

  it("garde l'état du réseau après une remise à zéro", () => {
    // Se déconnecter ne fait pas réapparaître le réseau.
    let state = reduce(initialState, { kind: "network", online: false });
    state = reduce(state, { kind: "reset" });

    expect(state.online).toBe(false);
    expect(state.tasks).toEqual([]);
  });
});

describe("pipeline vocal", () => {
  function makeVoice() {
    const stt = new FakeSpeechToText();
    const tts = new FakeTextToSpeech();
    const timers = new TestTimers();
    const states: string[] = [];
    const partials: string[] = [];

    const voice = new VoicePipeline({
      speechToText: stt,
      textToSpeech: tts,
      setTimer: timers.set,
      clearTimer: timers.clear,
      onStateChange: (state) => states.push(state),
      onPartial: (text) => partials.push(text),
    });

    return { voice, stt, tts, timers, states, partials };
  }

  it("écoute sur geste explicite, puis rend le texte", async () => {
    const v = makeVoice();

    await v.voice.startListening();
    expect(v.voice.isListening).toBe(true);

    expect(await v.voice.stopListening()).toBe("ouvre Spotify");
    expect(v.voice.state).toBe("idle");
  });

  it("n'écoute jamais de lui-même", () => {
    // Le port n'expose pas d'écoute continue : construire le pipeline ne doit
    // ouvrir aucun micro.
    const v = makeVoice();
    expect(v.stt.started).toBe(0);
    expect(v.voice.isListening).toBe(false);
  });

  it("remonte les résultats partiels sans rien envoyer", async () => {
    const v = makeVoice();
    await v.voice.startListening();
    v.stt.emitPartial("ouvre spo");

    expect(v.partials).toEqual(["ouvre spo"]);
    expect(v.stt.stopped).toBe(0);
  });

  it("refuse quand l'autorisation micro manque", async () => {
    const v = makeVoice();
    v.stt.permitted = false;

    await expect(v.voice.startListening()).rejects.toMatchObject({
      code: "MICROPHONE_UNAVAILABLE",
    });
    expect(v.stt.started).toBe(0);
  });

  it("abandonne sans transcrire à l'annulation", async () => {
    // L'utilisateur a changé d'avis : ce qu'il a dit ne doit aller nulle part.
    const v = makeVoice();
    await v.voice.startListening();
    await v.voice.cancelListening();

    expect(v.stt.cancelled).toBe(1);
    expect(v.stt.stopped).toBe(0);
    expect(v.voice.state).toBe("idle");
  });

  it("ferme le micro au bout du plafond de durée", async () => {
    // Filet de sécurité : un écran verrouillé ne doit pas laisser le micro
    // ouvert.
    const v = makeVoice();
    await v.voice.startListening();

    v.timers.flush();
    expect(v.stt.cancelled).toBe(1);
  });

  it("ne rend rien pour un appui accidentel", async () => {
    const v = makeVoice();
    v.stt.transcript = { text: "   " };

    await v.voice.startListening();
    expect(await v.voice.stopListening()).toBeUndefined();
  });

  it("ne lit pas à voix haute sans le demander", async () => {
    // Lire dans un lieu public ce qu'un assistant personnel répond est rarement
    // voulu.
    const v = makeVoice();
    expect(await v.voice.speak("Voilà le résultat.")).toBe(false);
    expect(v.tts.spoken).toEqual([]);
  });

  it("lit à voix haute quand l'utilisateur l'a activé", async () => {
    const v = makeVoice();
    v.voice.setSpeakReplies(true);

    expect(await v.voice.speak("Voilà le résultat.")).toBe(true);
    expect(v.tts.spoken).toEqual(["Voilà le résultat."]);
  });

  it("n'échoue pas quand la synthèse refuse", async () => {
    // La réponse est déjà affichée : faire échouer l'affichage parce que le
    // haut-parleur refuse serait absurde.
    const v = makeVoice();
    v.voice.setSpeakReplies(true);
    v.tts.failNext = true;

    expect(await v.voice.speak("Texte")).toBe(false);
    expect(v.voice.state).toBe("idle");
  });
});
