import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { VoiceState } from "@nexus/client-core";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

/**
 * Composer input bar.
 *
 * All inputs converge onto `onSend`.
 * The microphone only listens while held; no persistent listening mode exists.
 */

export interface ComposerProps {
  /** Resolves to false when the text was not delivered and should return to the field. */
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  onStartListening: () => void | Promise<void>;
  onStopListening: () => void | Promise<void>;
  onCancelListening: () => void | Promise<void>;
  voiceState: VoiceState;
  partialTranscript: string;
  /** False when disconnected: inputs are disabled rather than accepting unsent messages. */
  enabled: boolean;
  /** True while response is streaming: send button switches to "Stop". */
  busy?: boolean;
  onCancelResponse?: () => void;
  /** False if microphone is unavailable on device. */
  microphoneAvailable: boolean;
  /** What the route behind the current mode accepts. */
  maxLength?: number;
}

export function Composer(props: ComposerProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [text, setText] = useState("");
  const listening = props.voiceState === "listening";

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !props.enabled) return;

    setText("");
    void Promise.resolve(props.onSend(trimmed)).then((delivered) => {
      if (delivered === false) setText((current) => (current.length === 0 ? trimmed : current));
    });
  };

  return (
    <View style={styles.container}>
      {/* Realtime voice transcription stream */}
      {listening && (
        <View style={styles.transcriptRow}>
          <View style={styles.recordingDot} />
          <Text style={styles.transcript} numberOfLines={2}>
            {props.partialTranscript.length === 0
              ? "Speak… release to send"
              : props.partialTranscript}
          </Text>
          <Pressable
            onPress={() => {
              void props.onCancelListening();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel voice input"
            style={styles.linkButton}
          >
            <Text style={styles.linkText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={props.enabled ? "Ask NEXUS anything…" : "Waiting for NEXUS…"}
          placeholderTextColor={theme.color.textFaint}
          editable={props.enabled && !listening}
          multiline
          maxLength={props.maxLength ?? 4_000}
          onSubmitEditing={submit}
          accessibilityLabel="Message for NEXUS"
        />

        {props.microphoneAvailable && (
          <Pressable
            onPressIn={() => {
              void props.onStartListening();
            }}
            onPressOut={() => {
              void props.onStopListening();
            }}
            disabled={!props.enabled}
            style={[styles.micButton, listening && styles.micButtonActive]}
            accessibilityRole="button"
            accessibilityLabel="Hold to dictate"
            accessibilityHint="Microphone only listens while held"
          >
            <Ionicons
              name={listening ? "radio-button-on" : "mic-outline"}
              size={20}
              color={listening ? theme.color.textOnAccent : theme.color.text}
            />
          </Pressable>
        )}

        {props.busy === true && props.onCancelResponse !== undefined ? (
          <Pressable
            style={[styles.sendButton, styles.stopButton]}
            onPress={props.onCancelResponse}
            accessibilityRole="button"
            accessibilityLabel="Stop response"
          >
            <Ionicons name="stop" size={18} color={theme.color.text} />
          </Pressable>
        ) : (
          <Pressable
            style={[
              styles.sendButton,
              (!props.enabled || text.trim().length === 0) && styles.sendDisabled,
            ]}
            onPress={submit}
            disabled={!props.enabled || text.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <Ionicons name="arrow-up" size={20} color={theme.color.textOnAccent} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      borderTopWidth: 1,
      borderTopColor: theme.color.border,
      backgroundColor: theme.color.background,
      paddingHorizontal: theme.space(6),
      paddingTop: theme.space(5),
      paddingBottom: theme.space(6),
      gap: theme.space(4),
    },
    row: { flexDirection: "row", alignItems: "flex-end", gap: theme.space(4) },
    input: {
      flex: 1,
      minHeight: 44,
      maxHeight: 140,
      color: theme.color.text,
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.xl,
      paddingHorizontal: theme.space(6),
      paddingVertical: theme.space(5),
      fontSize: 16,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    micButton: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.surface,
      borderWidth: 1,
      borderColor: theme.color.border,
      alignItems: "center",
      justifyContent: "center",
    },
    micButtonActive: { backgroundColor: theme.color.danger, borderColor: theme.color.danger },
    sendButton: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    stopButton: { backgroundColor: theme.color.surfaceRaised },
    sendDisabled: { backgroundColor: theme.color.border },

    transcriptRow: { flexDirection: "row", alignItems: "center", gap: theme.space(4) },
    recordingDot: {
      width: 8,
      height: 8,
      borderRadius: theme.radius.pill,
      backgroundColor: theme.color.danger,
    },
    transcript: { flex: 1, color: theme.color.textMuted, fontSize: 14 },
    linkButton: { paddingVertical: theme.space(2), paddingHorizontal: theme.space(4) },
    linkText: { color: theme.color.accent, fontSize: 13, fontWeight: "600" },
  });
