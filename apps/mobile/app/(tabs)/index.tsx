import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  pendingConfirmations,
  type ConfirmationView,
  type MessageView,
  type TaskView,
  type ToolCallView,
} from "@nexus/client-core";
import { useNexus } from "../../lib/nexus.js";
import { sendBlocker, type SendMode } from "../../lib/chat-state.js";
import type { OrchestratedMission } from "../../lib/api-types.js";
import { Composer } from "../../components/composer.js";
import {
  ConfirmationCard,
  ConnectionBanner,
  ErrorBanner,
  MessageBubble,
  TaskCard,
  ToolCard,
} from "../../components/cards.js";
import { Badge, Card, type IconName } from "../../components/ui.js";
import { type Theme, useTheme, useThemedStyles } from "../../theme/index.js";

const MODES: { id: SendMode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Talk with the NEXUS agent" },
  { id: "action", label: "Action", hint: "Plan and run on your devices" },
  { id: "mission", label: "Mission", hint: "Delegate to multiple agents" },
];

/**
 * Main screen: conversation timeline.
 *
 * Messages, tool calls, tasks, and missions share one chronological feed.
 * Confirmations are pinned at the top to prevent losing actionable requests in
 * scroll history. The composer's mode says which route answers, because they
 * differ in what they can do: a conversation cannot start a task, and a task
 * cannot converse.
 */
export default function ChatScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();
  const { state, chat } = nexus;
  const listRef = useRef<FlatList<FeedItem>>(null);
  const navigation = useNavigation();

  const [microphoneAvailable, setMicrophoneAvailable] = useState(false);
  useEffect(() => {
    void nexus.voice.isSpeechAvailable().then(setMicrophoneAvailable);
  }, [nexus.voice]);

  const confirmations = useMemo(() => {
    const items: ConfirmationView[] = pendingConfirmations(state);
    const run = chat.pendingConfirmation;
    if (run === null) return items;
    return [
      ...items,
      {
        id: run.id,
        taskId: null,
        capability: run.toolName,
        action: `Run ${run.toolName}`,
        description: "The agent paused and needs your decision to continue.",
        riskLevel: run.riskLevel,
        expiresAt: run.expiresAt,
        answered: false,
      },
    ];
  }, [state, chat.pendingConfirmation]);

  const feed = useMemo(() => buildFeed(state, chat.missions), [state, chat.missions]);

  useEffect(() => {
    if (feed.length > 0) listRef.current?.scrollToEnd({ animated: true });
  }, [feed.length, state.messages]);

  const deviceNames = useMemo(
    () => new Map(state.devices.map((device) => [device.id, device.name])),
    [state.devices],
  );

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.kind === "message") return <MessageBubble message={item.message} />;
      if (item.kind === "tool") return <ToolCard call={item.call} />;
      if (item.kind === "mission") {
        return (
          <Card
            onPress={() => {
              router.push(`/mission/${item.mission.missionId}`);
            }}
            accessibilityLabel={`Open mission ${item.mission.title}`}
            style={{ marginVertical: theme.space(3) }}
          >
            <Text style={styles.missionTitle} numberOfLines={2}>
              {item.mission.title}
            </Text>
            <Badge status={item.mission.state} />
            <Text style={styles.missionHint}>Mission started. Tap to follow its progress.</Text>
          </Card>
        );
      }
      const device =
        item.task.workerDeviceId === null ? undefined : deviceNames.get(item.task.workerDeviceId);
      return (
        <TaskCard
          task={item.task}
          deviceName={device}
          onCancel={(taskId) => {
            void nexus.cancelTask(taskId);
          }}
        />
      );
    },
    [deviceNames, nexus.cancelTask, styles, theme],
  );

  const listen = useListenControls();

  const blocker = sendBlocker(nexus.sendMode, {
    text: "",
    online: state.online,
    realtime: state.connection === "connected",
    devicePending: nexus.devicePending,
  });

  useEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <HeaderButton
          icon="time-outline"
          label="Conversations"
          onPress={() => {
            router.push("/conversations");
          }}
        />
      ),
      headerRight: () => (
        <HeaderButton
          icon="create-outline"
          label="New conversation"
          onPress={nexus.newConversation}
        />
      ),
    });
  }, [navigation, nexus.newConversation]);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <ConnectionBanner connection={state.connection} online={state.online} />
      <DeviceTrustBanner />

      {confirmations.length > 0 && (
        <View style={styles.confirmations}>
          {confirmations.map((confirmation) => (
            <ConfirmationCard
              key={confirmation.id}
              confirmation={confirmation}
              onAnswer={(id, decision) => {
                if (id === chat.pendingConfirmation?.id) {
                  void nexus.answerRunConfirmation(decision);
                } else {
                  void nexus.answerConfirmation(id, decision);
                }
              }}
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
            {...(state.lastError.code === "CONNECTION_LOST"
              ? {
                  onRetry: () => {
                    void nexus.realtime.start();
                  },
                }
              : {})}
          />
        </View>
      )}

      {chat.historyTruncated && (
        <Text style={styles.truncated}>
          Very long conversation: only its first messages are loaded on this phone.
        </Text>
      )}

      {chat.loadingHistory ? (
        <View style={styles.empty}>
          <ActivityIndicator color={theme.color.accent} accessibilityLabel="Loading conversation" />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={feed}
          keyExtractor={(item) => `${item.kind}:${item.id}`}
          contentContainerStyle={styles.feed}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          removeClippedSubviews={Platform.OS === "android"}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={7}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>What can I do?</Text>
              <Text style={styles.emptyText}>
                Ask NEXUS a question, run an action on your workstation, or hand it a mission and
                get notified when it is done.
              </Text>
            </View>
          }
          ListFooterComponent={
            chat.running ? (
              <View style={styles.working} accessibilityLiveRegion="polite">
                <ActivityIndicator size="small" color={theme.color.signal} />
                <Text style={styles.workingText}>NEXUS is working…</Text>
              </View>
            ) : null
          }
        />
      )}

      <View style={styles.modes} accessibilityRole="radiogroup">
        {MODES.map((mode) => {
          const selected = nexus.sendMode === mode.id;
          return (
            <Pressable
              key={mode.id}
              style={[styles.mode, selected && styles.modeSelected]}
              onPress={() => {
                nexus.setSendMode(mode.id);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={mode.label}
              accessibilityHint={mode.hint}
            >
              <Text style={[styles.modeText, selected && styles.modeTextSelected]}>
                {mode.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {blocker !== undefined && <Text style={styles.blocker}>{blocker}</Text>}

      <Composer
        enabled={blocker === undefined && !chat.running}
        voiceState={nexus.voiceState}
        partialTranscript={nexus.partialTranscript}
        microphoneAvailable={microphoneAvailable}
        busy={chat.running && chat.activeRunId !== null}
        onCancelResponse={() => {
          void nexus.stopRun();
        }}
        onSend={(text) => nexus.send(text)}
        onStartListening={listen.start}
        onStopListening={listen.stop}
        onCancelListening={listen.cancel}
      />
    </KeyboardAvoidingView>
  );
}

function HeaderButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={{ paddingHorizontal: theme.space(6) }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={22} color={theme.color.text} />
    </Pressable>
  );
}

/**
 * Hold-to-talk wiring.
 *
 * Starting may show a permission dialog, so the finger can lift before the
 * recognizer runs. A release during that gap is remembered and honoured, or the
 * microphone would stay open with nobody holding the button.
 */
function useListenControls() {
  const nexus = useNexus();
  const released = useRef(false);

  const start = useCallback(async () => {
    released.current = false;
    await nexus.voice.stopSpeaking();
    try {
      await nexus.voice.startListening();
      if (released.current) await nexus.voice.cancelListening();
    } catch (cause) {
      nexus.reportError(cause);
    }
  }, [nexus]);

  const stop = useCallback(async () => {
    released.current = true;
    try {
      const text = await nexus.voice.stopListening();
      if (text !== undefined) await nexus.send(text);
    } catch (cause) {
      nexus.reportError(cause);
    }
  }, [nexus]);

  const cancel = useCallback(async () => {
    released.current = true;
    await nexus.voice.cancelListening();
  }, [nexus]);

  return { start, stop, cancel };
}

/** Sends the phone's approval state to the front: nothing realtime works until it clears. */
function DeviceTrustBanner() {
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();

  if (nexus.deviceTrust !== "pending" && nexus.deviceTrust !== "revoked") return null;

  const revoked = nexus.deviceTrust === "revoked";
  return (
    <View style={styles.trust} accessibilityLiveRegion="polite">
      <Ionicons
        name={revoked ? "ban-outline" : "time-outline"}
        size={16}
        color={styles.trustText.color}
      />
      <Text style={styles.trustText}>
        {revoked
          ? "This phone was revoked. Sign out, then pair it again from an approved device."
          : "This phone is waiting for approval. Open Devices on an approved client, or approve it from the dashboard. Chat works meanwhile; actions and live updates start once approved."}
      </Text>
    </View>
  );
}

type FeedItem =
  | { kind: "message"; id: string; at: string; message: MessageView }
  | { kind: "tool"; id: string; at: string; call: ToolCallView }
  | { kind: "task"; id: string; at: string; task: TaskView }
  | { kind: "mission"; id: string; at: string; mission: OrchestratedMission };

/** Items without a timestamp of their own (tool calls) stay after what preceded them. */
function buildFeed(
  state: { messages: MessageView[]; toolCalls: ToolCallView[]; tasks: TaskView[] },
  missions: OrchestratedMission[],
): FeedItem[] {
  const lastMessageAt = state.messages.at(-1)?.createdAt ?? "";
  const items: FeedItem[] = [
    ...state.messages.map((message) => ({
      kind: "message" as const,
      id: message.id,
      at: message.createdAt,
      message,
    })),
    ...state.tasks.map((task) => ({
      kind: "task" as const,
      id: task.id,
      at: task.startedAt ?? lastMessageAt,
      task,
    })),
    ...state.toolCalls.map((call) => ({
      kind: "tool" as const,
      id: call.callId,
      at: lastMessageAt,
      call,
    })),
    ...missions.map((mission) => ({
      kind: "mission" as const,
      id: mission.missionId,
      at: lastMessageAt,
      mission,
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.color.background },
    confirmations: { paddingHorizontal: theme.space(6) },
    errorHolder: { paddingHorizontal: theme.space(6), paddingVertical: theme.space(2) },
    feed: { paddingHorizontal: theme.space(6), paddingVertical: theme.space(5), flexGrow: 1 },
    empty: {
      flex: 1,
      justifyContent: "center",
      gap: theme.space(4),
      paddingHorizontal: theme.space(4),
    },
    emptyTitle: { color: theme.color.text, fontSize: 20, fontWeight: "600" },
    emptyText: { color: theme.color.textMuted, fontSize: 15, lineHeight: 21 },
    truncated: {
      color: theme.color.textFaint,
      fontSize: 12,
      textAlign: "center",
      paddingHorizontal: theme.space(6),
      paddingTop: theme.space(3),
    },
    working: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space(4),
      paddingVertical: theme.space(4),
    },
    workingText: { color: theme.color.textMuted, fontSize: 14 },
    missionTitle: { color: theme.color.text, fontSize: 15, fontWeight: "600" },
    missionHint: { color: theme.color.textMuted, fontSize: 13 },
    modes: {
      flexDirection: "row",
      gap: theme.space(3),
      paddingHorizontal: theme.space(6),
      paddingTop: theme.space(3),
      borderTopWidth: 1,
      borderTopColor: theme.color.border,
    },
    mode: {
      paddingHorizontal: theme.space(5),
      minHeight: 32,
      justifyContent: "center",
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    modeSelected: { backgroundColor: theme.color.accentMuted, borderColor: theme.color.accent },
    modeText: { color: theme.color.textMuted, fontSize: 13, fontWeight: "600" },
    modeTextSelected: { color: theme.color.accent },
    blocker: {
      color: theme.color.warning,
      fontSize: 12,
      paddingHorizontal: theme.space(6),
      paddingTop: theme.space(3),
    },
    trust: {
      flexDirection: "row",
      gap: theme.space(3),
      backgroundColor: theme.color.warningBg,
      paddingHorizontal: theme.space(6),
      paddingVertical: theme.space(4),
    },
    trustText: { flex: 1, color: theme.color.warning, fontSize: 13, lineHeight: 18 },
  });
