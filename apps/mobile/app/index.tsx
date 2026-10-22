import { useEffect, useMemo, useRef } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import {
  activeTasks,
  canInteract,
  pendingConfirmations,
  unreadNotifications,
  type MessageView,
  type TaskView,
  type ToolCallView,
} from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { Composer } from "../components/composer.js";
import {
  ConfirmationCard,
  ConnectionBanner,
  ErrorBanner,
  MessageBubble,
  TaskCard,
  ToolCard,
} from "../components/cards.js";
import { theme } from "../theme/index.js";

/**
 * Main screen: conversation timeline.
 *
 * Messages, tool calls, tasks, and confirmations stream into a single chronological feed.
 * Confirmations are pinned at the top to prevent losing actionable requests in scroll history.
 */
export default function ChatScreen() {
  const nexus = useNexus();
  const { state } = nexus;
  const listRef = useRef<FlatList<FeedItem>>(null);

  const confirmations = pendingConfirmations(state);
  const running = activeTasks(state);
  const unread = unreadNotifications(state).length;
  const interactive = canInteract(state);

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...state.messages.map((message) => ({ kind: "message" as const, id: message.id, message })),
      ...state.toolCalls.map((call) => ({ kind: "tool" as const, id: call.callId, call })),
      ...state.tasks.map((task) => ({ kind: "task" as const, id: task.id, task })),
    ];
    return items;
  }, [state.messages, state.toolCalls, state.tasks]);

  useEffect(() => {
    if (feed.length > 0) listRef.current?.scrollToEnd({ animated: true });
  }, [feed.length, state.messages]);

  if (!nexus.ready) return <View style={styles.screen} />;
  if (!nexus.authenticated) return <Redirect href="/login" />;

  const deviceNameOf = (deviceId: string | null): string | undefined =>
    state.devices.find((device) => device.id === deviceId)?.name;

  return (
    <View style={styles.screen}>
      <ConnectionBanner connection={state.connection} online={state.online} />

      <View style={styles.toolbar}>
        <NavChip label="Tasks" badge={running.length} onPress={() => router.push("/tasks")} />
        <NavChip label="Devices" onPress={() => router.push("/devices")} />
        <NavChip label="Alerts" badge={unread} onPress={() => router.push("/notifications")} />
        <NavChip label="Memory" onPress={() => router.push("/memory")} />
        <NavChip label="Settings" onPress={() => router.push("/settings")} />
      </View>

      {confirmations.length > 0 && (
        <View style={styles.confirmations}>
          {confirmations.map((confirmation) => (
            <ConfirmationCard
              key={confirmation.id}
              confirmation={confirmation}
              onAnswer={(id, decision) => void nexus.answerConfirmation(id, decision)}
            />
          ))}
        </View>
      )}

      {state.lastError !== null && (
        <View style={styles.errorHolder}>
          <ErrorBanner
            message={state.lastError.message}
            onDismiss={() => {
              nexus.dismissError();
            }}
            onRetry={() => {
              void nexus.realtime.start();
            }}
          />
        </View>
      )}

      <FlatList
        ref={listRef}
        data={feed}
        keyExtractor={(item) => `${item.kind}:${item.id}`}
        contentContainerStyle={styles.feed}
        renderItem={({ item }) => {
          if (item.kind === "message") return <MessageBubble message={item.message} />;
          if (item.kind === "tool") return <ToolCard call={item.call} />;

          return (
            <TaskCard
              task={item.task}
              {...(deviceNameOf(item.task.workerDeviceId) === undefined
                ? {}
                : { deviceName: deviceNameOf(item.task.workerDeviceId) })}
              onCancel={(taskId) => {
                void nexus.cancelTask(taskId);
              }}
            />
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>What can I do?</Text>
            <Text style={styles.emptyText}>
              Ask NEXUS to run tests on your workstation, trigger actions on your phone,
              or notify you when tasks complete.
            </Text>
          </View>
        }
      />

      <Composer
        enabled={interactive}
        voiceState={nexus.voiceState}
        partialTranscript={nexus.partialTranscript}
        microphoneAvailable={false}
        onSend={(text) => {
          void nexus.send(text);
        }}
        onStartListening={() => {
          void nexus.voice.startListening();
        }}
        onStopListening={async () => {
          const text = await nexus.voice.stopListening();
          if (text !== undefined) await nexus.send(text);
        }}
        onCancelListening={() => {
          void nexus.voice.cancelListening();
        }}
      />
    </View>
  );
}

type FeedItem =
  | { kind: "message"; id: string; message: MessageView }
  | { kind: "tool"; id: string; call: ToolCallView }
  | { kind: "task"; id: string; task: TaskView };

function NavChip({
  label,
  badge,
  onPress,
}: {
  label: string;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.chip} onPress={onPress} accessibilityRole="button">
      <Text style={styles.chipText}>{label}</Text>
      {badge !== undefined && badge > 0 && (
        <View style={styles.chipBadge}>
          <Text style={styles.chipBadgeText}>{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.background },
  toolbar: {
    flexDirection: "row",
    gap: theme.space(2),
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2),
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  chipText: { color: theme.color.textMuted, fontSize: 13, fontWeight: "600" },
  chipBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space(1),
  },
  chipBadgeText: { color: theme.color.text, fontSize: 11, fontWeight: "700" },

  confirmations: { paddingHorizontal: theme.space(4) },
  errorHolder: { paddingHorizontal: theme.space(4), paddingVertical: theme.space(1) },
  feed: { paddingHorizontal: theme.space(4), paddingVertical: theme.space(3), flexGrow: 1 },

  empty: {
    flex: 1,
    justifyContent: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(2),
  },
  emptyTitle: { color: theme.color.text, fontSize: 20, fontWeight: "600" },
  emptyText: { color: theme.color.textMuted, fontSize: 15, lineHeight: 21 },
});
