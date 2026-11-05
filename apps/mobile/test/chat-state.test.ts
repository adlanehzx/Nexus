import { describe, expect, it, vi } from "vitest";
import type { MessageView, NotificationView } from "@nexus/client-core";
import { initialState } from "@nexus/client-core";
import {
  LOCAL_MESSAGE_PREFIX,
  mergeMessages,
  mergeNotifications,
  reduceMobile,
  sendBlocker,
} from "../lib/chat-state.js";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const message = (over: Partial<MessageView>): MessageView => ({
  id: "m1",
  role: "user",
  content: "hello",
  streaming: false,
  createdAt: "2026-11-05T10:00:00.000Z",
  originClientDeviceId: null,
  ...over,
});

const notification = (over: Partial<NotificationView>): NotificationView => ({
  id: "n1",
  title: "t",
  body: "b",
  severity: "info",
  readAt: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  ...over,
});

describe("mergeMessages", () => {
  it("replaces an optimistic message once the server holds the same text", () => {
    const local = message({ id: `${LOCAL_MESSAGE_PREFIX}1` });
    const merged = mergeMessages([local], [message({ id: "server-1" })]);
    expect(merged.map((item) => item.id)).toEqual(["server-1"]);
  });

  it("keeps an optimistic message the server does not hold yet", () => {
    const local = message({ id: `${LOCAL_MESSAGE_PREFIX}2`, content: "unsent" });
    const merged = mergeMessages([local], [message({ id: "server-1" })]);
    expect(merged.map((item) => item.id)).toEqual(["server-1", local.id]);
  });

  it("matches repeated text one for one", () => {
    const history = [message({ id: "s1" })];
    const current = [
      message({ id: `${LOCAL_MESSAGE_PREFIX}1` }),
      message({ id: `${LOCAL_MESSAGE_PREFIX}2` }),
    ];
    expect(mergeMessages(current, history).map((item) => item.id)).toEqual([
      "s1",
      `${LOCAL_MESSAGE_PREFIX}2`,
    ]);
  });

  it("keeps a message still streaming and drops other non-local ones", () => {
    const streaming = message({ id: "s9", role: "assistant", content: "par", streaming: true });
    const finished = message({ id: "s8", role: "assistant", content: "old" });
    const merged = mergeMessages([streaming, finished], [message({ id: "s1" })]);
    expect(merged.map((item) => item.id)).toEqual(["s1", "s9"]);
  });

  it("prefers the server copy of a known id", () => {
    const merged = mergeMessages(
      [message({ id: "s1", content: "stale" })],
      [message({ id: "s1", content: "fresh" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("fresh");
  });
});

describe("mergeNotifications", () => {
  it("sorts newest first and keeps an event that arrived during the fetch", () => {
    const live = notification({ id: "live", createdAt: "2026-11-05T12:00:00.000Z" });
    const old = notification({ id: "old", createdAt: "2026-11-05T09:00:00.000Z" });
    expect(mergeNotifications([live], [old]).map((item) => item.id)).toEqual(["live", "old"]);
  });

  it("never undoes a local read mark", () => {
    const read = notification({ readAt: "2026-11-05T11:00:00.000Z" });
    expect(mergeNotifications([read], [notification({})])[0]?.readAt).toBe(read.readAt);
  });
});

describe("reduceMobile", () => {
  it("delegates shared actions to the client-core reducer", () => {
    const state = reduceMobile(initialState, { kind: "network", online: false });
    expect(state.online).toBe(false);
  });

  it("clearMessages empties the timeline but not tasks or devices", () => {
    const seeded = {
      ...initialState,
      messages: [message({})],
      devices: [
        {
          id: "d",
          name: "n",
          role: "CLIENT",
          status: "ONLINE",
          capabilities: [],
          lastSeenAt: null,
        },
      ],
    };
    const state = reduceMobile(seeded, { kind: "clearMessages" });
    expect(state.messages).toEqual([]);
    expect(state.devices).toHaveLength(1);
  });

  it("hydrates history and notifications", () => {
    let state = reduceMobile(initialState, { kind: "hydrateMessages", messages: [message({})] });
    state = reduceMobile(state, {
      kind: "hydrateNotifications",
      notifications: [notification({})],
    });
    expect(state.messages).toHaveLength(1);
    expect(state.notifications).toHaveLength(1);
  });
});

describe("sendBlocker", () => {
  const ready = { online: true, realtime: true, devicePending: false };

  it("blocks everything offline", () => {
    expect(sendBlocker("chat", { ...ready, online: false })).toMatch(/offline/);
  });

  it("lets chat work over REST without the realtime channel or approval", () => {
    expect(sendBlocker("chat", { ...ready, realtime: false, devicePending: true })).toBeUndefined();
    expect(sendBlocker("mission", { ...ready, realtime: false })).toBeUndefined();
  });

  it("requires approval and the channel for actions", () => {
    expect(sendBlocker("action", { ...ready, devicePending: true })).toMatch(/Approve/);
    expect(sendBlocker("action", { ...ready, realtime: false })).toMatch(/live connection/);
    expect(sendBlocker("action", ready)).toBeUndefined();
  });
});
