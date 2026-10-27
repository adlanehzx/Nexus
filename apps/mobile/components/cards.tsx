import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ConfirmationView, MessageView, TaskView, ToolCallView } from "@nexus/client-core";
import {
  type Theme,
  riskColor,
  statusColor,
  statusLabel,
  useTheme,
  useThemedStyles,
} from "../theme/index.js";

/**
 * Conversation cards.
 *
 * One core rule: **a card shows what is happening, never raw internal arguments**.
 * A `terminal.execute` shows "Run test suite on workstation", not the raw command line.
 * The server sends formatted summaries intentionally.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Message
// ─────────────────────────────────────────────────────────────────────────────

export function MessageBubble({ message }: { message: MessageView }) {
  const styles = useThemedStyles(makeStyles);
  const mine = message.role === "user";

  return (
    <View style={[styles.bubbleRow, mine ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={styles.bubbleText}>{message.content}</Text>

        {/* Streaming cursor */}
        {message.streaming && <Text style={styles.cursor}>▌</Text>}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task
// ─────────────────────────────────────────────────────────────────────────────

export function TaskCard({
  task,
  deviceName,
  onCancel,
}: {
  task: TaskView;
  deviceName?: string | undefined;
  onCancel?: ((taskId: string) => void) | undefined;
}) {
  const styles = useThemedStyles(makeStyles);
  const running = task.status === "running" || task.status === "pending";

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {task.title}
        </Text>
        <Text style={[styles.badge, { color: statusColor(task.status) }]}>
          {statusLabel(task.status)}
        </Text>
      </View>

      {/* Target worker is named */}
      {deviceName !== undefined && <Text style={styles.cardMeta}>on {deviceName}</Text>}

      {task.label !== null && (
        <Text style={styles.cardMeta} numberOfLines={1}>
          {task.label}
        </Text>
      )}

      {running && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${task.percent}%` }]} />
        </View>
      )}

      {task.error !== null && (
        <Text style={styles.errorText} numberOfLines={3}>
          {task.error.message}
        </Text>
      )}

      <View style={styles.cardFooter}>
        <Text style={styles.cardFaint}>
          {task.startedAt === null ? "" : formatTime(task.startedAt)}
          {task.durationMs === null ? "" : ` · ${formatDuration(task.durationMs)}`}
        </Text>

        {running && onCancel !== undefined && (
          <Pressable
            style={styles.linkButton}
            onPress={() => {
              onCancel(task.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Cancel ${task.title}`}
          >
            <Text style={styles.linkText}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Call
// ─────────────────────────────────────────────────────────────────────────────

export function ToolCard({ call }: { call: ToolCallView }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.card, styles.toolCard]}>
      <View style={styles.cardHeader}>
        <Text style={styles.toolName}>{call.tool}</Text>
        <Text style={[styles.riskChip, { color: riskColor(call.riskLevel) }]}>
          {call.riskLevel}
        </Text>
      </View>

      <Text style={styles.cardMeta} numberOfLines={3}>
        {call.summary}
      </Text>

      <View style={styles.cardFooter}>
        {call.status === "running" ? (
          <View style={styles.inline}>
            <ActivityIndicator size="small" color={theme.color.accent} />
            <Text style={styles.cardFaint}>{call.label ?? "running"}</Text>
          </View>
        ) : (
          <Text style={[styles.cardFaint, { color: statusColor(call.status) }]}>
            {call.status === "succeeded" ? "completed" : "failed"}
            {call.durationMs === null ? "" : ` · ${formatDuration(call.durationMs)}`}
          </Text>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirmation request.
 *
 * Three safeguards against accidental approvals:
 *  1. Reject is positioned for safe default interaction.
 *  2. Above MEDIUM risk, two taps are required (arm + confirm).
 *  3. Explicit risk level and consistent coloring.
 */
export function ConfirmationCard({
  confirmation,
  onAnswer,
}: {
  confirmation: ConfirmationView;
  onAnswer: (id: string, decision: "approved" | "rejected") => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [armed, setArmed] = useState(false);
  const highRisk = confirmation.riskLevel === "HIGH" || confirmation.riskLevel === "CRITICAL";

  const approve = () => {
    if (highRisk && !armed) {
      setArmed(true);
      return;
    }
    onAnswer(confirmation.id, "approved");
  };

  return (
    <View
      style={[styles.card, styles.confirmCard, { borderColor: riskColor(confirmation.riskLevel) }]}
    >
      <Text style={styles.confirmIntro}>NEXUS requests to:</Text>
      <Text style={styles.confirmAction}>{confirmation.action}</Text>

      {confirmation.description !== confirmation.action && (
        <Text style={styles.cardMeta} numberOfLines={4}>
          {confirmation.description}
        </Text>
      )}

      <View style={styles.riskRow}>
        <Text style={styles.cardFaint}>Risk</Text>
        <Text style={[styles.riskValue, { color: riskColor(confirmation.riskLevel) }]}>
          {confirmation.riskLevel}
        </Text>
      </View>

      {armed && (
        <Text style={styles.armedNotice}>
          Tap "Approve" again to confirm this {confirmation.riskLevel} risk action.
        </Text>
      )}

      <View style={styles.confirmActions}>
        <Pressable
          style={[styles.button, styles.buttonNeutral]}
          onPress={() => {
            onAnswer(confirmation.id, "rejected");
          }}
          accessibilityRole="button"
          accessibilityLabel="Reject this action"
        >
          <Text style={styles.buttonNeutralText}>Reject</Text>
        </Pressable>

        <Pressable
          style={[
            styles.button,
            armed ? styles.buttonArmed : styles.buttonApprove,
            { borderColor: riskColor(confirmation.riskLevel) },
          ]}
          onPress={approve}
          accessibilityRole="button"
          accessibilityLabel={armed ? "Confirm this action" : "Approve this action"}
        >
          <Text style={styles.buttonApproveText}>{armed ? "Confirm" : "Approve"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error
// ─────────────────────────────────────────────────────────────────────────────

export function ErrorBanner({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText} numberOfLines={3}>
        {message}
      </Text>

      <View style={styles.inline}>
        {onRetry !== undefined && (
          <Pressable style={styles.linkButton} onPress={onRetry} accessibilityRole="button">
            <Text style={styles.linkText}>Retry</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.linkButton}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
        >
          <Text style={styles.bannerDismiss}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Connection status banner. Visible only when disconnected or reconnecting. */
export function ConnectionBanner({ connection, online }: { connection: string; online: boolean }) {
  const styles = useThemedStyles(makeStyles);
  if (online && connection === "connected") return null;

  const message = !online
    ? "Offline — NEXUS will resume when network reconnects."
    : connection === "reconnecting"
      ? "Reconnecting to NEXUS…"
      : "Connecting to NEXUS…";

  return (
    <View style={styles.connectionBanner}>
      <Text style={styles.connectionText}>{message}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Format
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${String(Math.round(ms / 60_000))} min`;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    bubbleRow: { flexDirection: "row", marginVertical: theme.space(2) },
    rowRight: { justifyContent: "flex-end" },
    rowLeft: { justifyContent: "flex-start" },
    bubble: {
      maxWidth: "85%",
      paddingVertical: theme.space(5),
      paddingHorizontal: theme.space(6),
      borderRadius: theme.radius.xl,
    },
    bubbleMine: { backgroundColor: theme.color.accent },
    bubbleTheirs: { backgroundColor: theme.color.surfaceRaised },
    bubbleText: { color: theme.color.text, fontSize: 16, lineHeight: 22 },
    cursor: { color: theme.color.textMuted, fontSize: 14 },

    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      padding: theme.space(6),
      marginVertical: theme.space(3),
      gap: theme.space(3),
    },
    toolCard: { backgroundColor: theme.color.surfaceRaised },
    confirmCard: { borderWidth: 2 },
    cardHeader: { flexDirection: "row", justifyContent: "space-between", gap: theme.space(4) },
    cardTitle: { color: theme.color.text, fontSize: 15, fontWeight: "600", flex: 1 },
    cardMeta: { color: theme.color.textMuted, fontSize: 13, lineHeight: 18 },
    cardFaint: { color: theme.color.textFaint, fontSize: 12 },
    cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    badge: { fontSize: 12, fontWeight: "600" },
    toolName: {
      color: theme.color.text,
      fontSize: 14,
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
    },
    riskChip: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
    errorText: { color: theme.color.danger, fontSize: 13, lineHeight: 18 },

    progressTrack: {
      height: 4,
      backgroundColor: theme.color.border,
      borderRadius: theme.radius.pill,
      overflow: "hidden",
    },
    progressFill: { height: 4, backgroundColor: theme.color.accent },

    confirmIntro: { color: theme.color.textMuted, fontSize: 13 },
    confirmAction: { color: theme.color.text, fontSize: 17, fontWeight: "600", lineHeight: 23 },
    riskRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    riskValue: { fontSize: 15, fontWeight: "700", letterSpacing: 0.5 },
    armedNotice: { color: theme.color.warning, fontSize: 13, lineHeight: 18 },
    confirmActions: { flexDirection: "row", gap: theme.space(5), marginTop: theme.space(2) },
    button: {
      flex: 1,
      paddingVertical: theme.space(6),
      borderRadius: theme.radius.lg,
      alignItems: "center",
      borderWidth: 1,
    },
    buttonNeutral: { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.border },
    buttonNeutralText: { color: theme.color.text, fontSize: 15, fontWeight: "600" },
    buttonApprove: { backgroundColor: "transparent" },
    buttonArmed: { backgroundColor: theme.color.surfaceRaised },
    buttonApproveText: { color: theme.color.text, fontSize: 15, fontWeight: "700" },

    banner: {
      backgroundColor: theme.color.surfaceRaised,
      borderLeftWidth: 3,
      borderLeftColor: theme.color.danger,
      padding: theme.space(5),
      borderRadius: theme.radius.md,
      gap: theme.space(3),
    },
    bannerText: { color: theme.color.text, fontSize: 14, lineHeight: 19 },
    bannerDismiss: { color: theme.color.textMuted, fontSize: 13 },

    connectionBanner: {
      backgroundColor: theme.color.surfaceRaised,
      paddingVertical: theme.space(4),
      paddingHorizontal: theme.space(6),
      alignItems: "center",
    },
    connectionText: { color: theme.color.textMuted, fontSize: 13 },

    linkButton: { paddingVertical: theme.space(2), paddingHorizontal: theme.space(4) },
    linkText: { color: theme.color.accent, fontSize: 13, fontWeight: "600" },
    inline: { flexDirection: "row", alignItems: "center", gap: theme.space(4) },
  });
