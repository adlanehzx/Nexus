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
 * Reducer and voice pipeline tests.
 */

function apply(state: ClientState, type: ServerToClientType, payload: Record<string, unknown>) {
  return reduce(state, {
    kind: "server",
    type,
    payload: { ts: "2026-09-02T12:00:00.000Z", ...payload },
  });
}

describe("streaming response flow", () => {
  it("creates message on first chunk", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.messageDelta, {
      conversationId: "c1",
      messageId: "m1",
      delta: "Hel",
      done: false,
    });

    expect(state.messages[0]).toMatchObject({ id: "m1", content: "Hel", streaming: true });
  });

  it("concatenates subsequent chunks", () => {
    let state = initialState;
    for (const delta of ["Hel", "lo ", "Alex"]) {
      state = apply(state, SERVER_TO_CLIENT.messageDelta, {
        conversationId: "c1",
        messageId: "m1",
        delta,
        done: false,
      });
    }

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("Hello Alex");
  });

  it("closes stream on final chunk", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.messageDelta, {
      messageId: "m1",
      delta: "Hello",
      done: false,
    });
    state = apply(state, SERVER_TO_CLIENT.messageDelta, {
      messageId: "m1",
      delta: ".",
      done: true,
    });

    expect(state.messages[0]).toMatchObject({ content: "Hello.", streaming: false });
  });

  it("keeps user and assistant messages separated", () => {
    let state = reduce(initialState, {
      kind: "localMessage",
      message: {
        id: "u1",
        role: "user",
        content: "Open Spotify",
        streaming: false,
        createdAt: "2026-09-02T12:00:00.000Z",
        originClientDeviceId: "device-iphone",
      },
    });
    state = apply(state, SERVER_TO_CLIENT.messageDelta, {
      messageId: "a1",
      delta: "Done.",
      done: true,
    });

    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("tasks", () => {
  it("creates a task", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Run tests",
      stepCount: 3,
      originClientDeviceId: "device-iphone",
    });

    expect(state.tasks[0]).toMatchObject({
      id: "t1",
      title: "Run tests",
      status: "pending",
      stepCount: 3,
      originClientDeviceId: "device-iphone",
    });
  });

  it("tracks progress", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Tests",
      stepCount: 2,
    });
    state = apply(state, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s1",
      percent: 50,
      label: "Cloning repository",
    });

    expect(state.tasks[0]).toMatchObject({
      status: "running",
      percent: 50,
      label: "Cloning repository",
    });
  });

  it("records success", () => {
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

  it("distinguishes partial success", () => {
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

  it("stores failure error details", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Tests",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskFailed, {
      taskId: "t1",
      code: "PATH_NOT_ALLOWED",
      message: "This path is outside permitted directories.",
    });

    expect(state.tasks[0]).toMatchObject({
      status: "failed",
      error: { code: "PATH_NOT_ALLOWED" },
    });
  });

  it("retains worker reported in progress frame", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Compile",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s1",
      deviceId: "device-fixed",
      percent: 40,
      label: null,
    });

    expect(state.tasks[0]?.workerDeviceId).toBe("device-fixed");
  });

  it("does not overwrite known worker with null on anonymous progress", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t1",
      stepId: "s1",
      deviceId: "device-laptop",
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

    expect(state.tasks[0]?.workerDeviceId).toBe("device-laptop");
  });

  it("creates task known only through progress updates", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.taskProgress, {
      taskId: "t-unknown",
      stepId: "s1",
      percent: 30,
      label: "running",
    });

    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.status).toBe("running");
  });

  it("separates active and finished tasks", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t1",
      title: "Running",
      stepCount: 1,
    });
    state = apply(state, SERVER_TO_CLIENT.taskCreated, {
      taskId: "t2",
      title: "Done",
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

describe("tool calls", () => {
  it("tracks tool call lifecycle end to end", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.toolStarted, {
      runId: "r1",
      callId: "c1",
      tool: "device.terminal.execute",
      summary: "Run tests on desktop",
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
      summary: "240 tests passed",
      durationMs: 12_000,
    });
    expect(state.toolCalls[0]).toMatchObject({ status: "succeeded", percent: 100 });
  });
});

describe("confirmations", () => {
  it("adds confirmation request", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.confirmationRequired, {
      confirmationId: "k1",
      taskId: "t1",
      capability: "terminal.execute",
      action: "Execute command on desktop",
      description: "pnpm test",
      riskLevel: "HIGH",
      expiresAt: "2026-09-02T12:10:00.000Z",
    });

    expect(pendingConfirmations(state)).toHaveLength(1);
    expect(state.confirmations[0]).toMatchObject({ riskLevel: "HIGH", answered: false });
  });

  it("does not duplicate replayed confirmation requests", () => {
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

  it("marks confirmation as answered", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.confirmationRequired, {
      confirmationId: "k1",
      action: "x",
      description: "y",
      riskLevel: "HIGH",
      expiresAt: "2026-09-02T12:10:00.000Z",
    });
    state = reduce(state, { kind: "confirmationAnswered", confirmationId: "k1" });

    expect(pendingConfirmations(state)).toHaveLength(0);
    expect(state.confirmations[0]?.answered).toBe(true);
  });
});

describe("notifications", () => {
  it("prepends most recent notification", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n1",
      title: "First",
      body: "x",
      severity: "info",
    });
    state = apply(state, SERVER_TO_CLIENT.notificationCreated, {
      notificationId: "n2",
      title: "Second",
      body: "y",
      severity: "error",
    });

    expect(state.notifications.map((n) => n.title)).toEqual(["Second", "First"]);
  });

  it("does not duplicate replayed notification", () => {
    const payload = { notificationId: "n1", title: "x", body: "y", severity: "info" };
    let state = apply(initialState, SERVER_TO_CLIENT.notificationCreated, payload);
    state = apply(state, SERVER_TO_CLIENT.notificationCreated, payload);

    expect(state.notifications).toHaveLength(1);
  });

  it("marks notification as read", () => {
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

describe("devices", () => {
  it("adds unknown device", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.deviceUpdated, {
      deviceId: "d1",
      deviceName: "Desktop PC",
      status: "ONLINE",
      role: "WORKER",
      capabilities: ["terminal.execute"],
    });

    expect(state.devices[0]).toMatchObject({ id: "d1", name: "Desktop PC", status: "ONLINE" });
  });

  it("updates device without wiping omitted fields", () => {
    let state = apply(initialState, SERVER_TO_CLIENT.deviceUpdated, {
      deviceId: "d1",
      deviceName: "Desktop PC",
      status: "ONLINE",
      role: "WORKER",
      capabilities: ["terminal.execute"],
    });
    state = apply(state, SERVER_TO_CLIENT.deviceUpdated, { deviceId: "d1", status: "OFFLINE" });

    expect(state.devices[0]).toMatchObject({
      name: "Desktop PC",
      status: "OFFLINE",
      capabilities: ["terminal.execute"],
    });
  });
});

describe("connection state", () => {
  it("allows interaction only when connected and online", () => {
    let state = reduce(initialState, { kind: "connection", state: "connected" });
    expect(canInteract(state)).toBe(true);

    state = reduce(state, { kind: "network", online: false });
    expect(canInteract(state)).toBe(false);
  });

  it("clears displayed error", () => {
    let state = reduce(initialState, {
      kind: "error",
      code: "CONNECTION_LOST",
      message: "Connection lost",
      at: "2026-09-02T12:00:00.000Z",
    });
    expect(state.lastError).not.toBeNull();

    state = reduce(state, { kind: "clearError" });
    expect(state.lastError).toBeNull();
  });

  it("leaves state unchanged on no-op frame", () => {
    const state = apply(initialState, SERVER_TO_CLIENT.agentStarted, {
      runId: "r1",
      conversationId: "c1",
    });
    expect(state).toEqual(initialState);
  });

  it("preserves network status upon reset", () => {
    let state = reduce(initialState, { kind: "network", online: false });
    state = reduce(state, { kind: "reset" });

    expect(state.online).toBe(false);
    expect(state.tasks).toEqual([]);
  });
});

describe("voice pipeline", () => {
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

  it("listens on explicit action then returns transcription", async () => {
    const v = makeVoice();

    await v.voice.startListening();
    expect(v.voice.isListening).toBe(true);

    expect(await v.voice.stopListening()).toBe("open Spotify");
    expect(v.voice.state).toBe("idle");
  });

  it("never listens automatically", () => {
    const v = makeVoice();
    expect(v.stt.started).toBe(0);
    expect(v.voice.isListening).toBe(false);
  });

  it("streams partial transcriptions without sending", async () => {
    const v = makeVoice();
    await v.voice.startListening();
    v.stt.emitPartial("open spo");

    expect(v.partials).toEqual(["open spo"]);
    expect(v.stt.stopped).toBe(0);
  });

  it("rejects when microphone permission is denied", async () => {
    const v = makeVoice();
    v.stt.permitted = false;

    await expect(v.voice.startListening()).rejects.toMatchObject({
      code: "MICROPHONE_UNAVAILABLE",
    });
    expect(v.stt.started).toBe(0);
  });

  it("discards transcription upon cancellation", async () => {
    const v = makeVoice();
    await v.voice.startListening();
    await v.voice.cancelListening();

    expect(v.stt.cancelled).toBe(1);
    expect(v.stt.stopped).toBe(0);
    expect(v.voice.state).toBe("idle");
  });

  it("stops microphone upon reaching duration cap", async () => {
    const v = makeVoice();
    await v.voice.startListening();

    v.timers.flush();
    expect(v.stt.cancelled).toBe(1);
  });

  it("returns undefined for accidental tap with empty transcription", async () => {
    const v = makeVoice();
    v.stt.transcript = { text: "   " };

    await v.voice.startListening();
    expect(await v.voice.stopListening()).toBeUndefined();
  });

  it("does not speak aloud unless requested", async () => {
    const v = makeVoice();
    expect(await v.voice.speak("Here is the result.")).toBe(false);
    expect(v.tts.spoken).toEqual([]);
  });

  it("speaks aloud when enabled by user", async () => {
    const v = makeVoice();
    v.voice.setSpeakReplies(true);

    expect(await v.voice.speak("Here is the result.")).toBe(true);
    expect(v.tts.spoken).toEqual(["Here is the result."]);
  });

  it("does not fail when speech synthesis is unavailable", async () => {
    const v = makeVoice();
    v.voice.setSpeakReplies(true);
    v.tts.failNext = true;

    expect(await v.voice.speak("Text")).toBe(false);
    expect(v.voice.state).toBe("idle");
  });
});
