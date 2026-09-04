import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { VoiceState } from "@nexus/client-core";
import { theme } from "../theme/index.js";

/**
 * La zone de saisie.
 *
 * Trois entrées, une seule sortie : le texte tapé, le texte dicté et
 * l'annulation aboutissent tous à `onSend` ou à rien. Un composant qui aurait
 * deux chemins d'envoi finirait par en avoir un mal testé.
 *
 * Le micro suit le principe du reste du système : **il n'écoute que pendant
 * l'appui**. Il n'y a pas de mode « mains libres », et le bouton le dit — il
 * affiche « Relâchez pour envoyer » tant qu'il est enfoncé.
 */

export interface ComposerProps {
  onSend: (text: string) => void | Promise<void>;
  onStartListening: () => void | Promise<void>;
  onStopListening: () => void | Promise<void>;
  onCancelListening: () => void | Promise<void>;
  voiceState: VoiceState;
  partialTranscript: string;
  /** Faux quand le réseau ou la connexion manque : on grise plutôt que de mentir. */
  enabled: boolean;
  /** Vrai pendant qu'une réponse arrive : le bouton devient « Arrêter ». */
  busy?: boolean;
  onCancelResponse?: () => void;
  /** Absent = le micro n'est pas disponible sur cet appareil. */
  microphoneAvailable: boolean;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const listening = props.voiceState === "listening";

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !props.enabled) return;

    setText("");
    void props.onSend(trimmed);
  };

  return (
    <View style={styles.container}>
      {/* Ce que la reconnaissance entend, affiché au fil de la parole. Rien
          n'est envoyé tant que l'utilisateur n'a pas relâché. */}
      {listening && (
        <View style={styles.transcriptRow}>
          <View style={styles.recordingDot} />
          <Text style={styles.transcript} numberOfLines={2}>
            {props.partialTranscript.length === 0
              ? "Parlez… relâchez pour envoyer"
              : props.partialTranscript}
          </Text>
          <Pressable
            onPress={() => {
              void props.onCancelListening();
            }}
            accessibilityRole="button"
            accessibilityLabel="Annuler la dictée"
            style={styles.linkButton}
          >
            <Text style={styles.linkText}>Annuler</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={props.enabled ? "Demandez quelque chose à NEXUS…" : "Hors ligne"}
          placeholderTextColor={theme.color.textFaint}
          editable={props.enabled && !listening}
          multiline
          maxLength={4_000}
          onSubmitEditing={submit}
          accessibilityLabel="Message à envoyer à NEXUS"
        />

        {props.microphoneAvailable && (
          <Pressable
            // Appui maintenu : le micro s'ouvre au contact et se ferme au
            // relâchement. Aucun état « écoute » ne survit au geste.
            onPressIn={() => {
              void props.onStartListening();
            }}
            onPressOut={() => {
              void props.onStopListening();
            }}
            disabled={!props.enabled}
            style={[styles.micButton, listening && styles.micButtonActive]}
            accessibilityRole="button"
            accessibilityLabel="Maintenir pour dicter"
            accessibilityHint="Le micro n'écoute que pendant l'appui"
          >
            <Text style={styles.micGlyph}>{listening ? "●" : "🎙"}</Text>
          </Pressable>
        )}

        {props.busy === true && props.onCancelResponse !== undefined ? (
          <Pressable
            style={[styles.sendButton, styles.stopButton]}
            onPress={props.onCancelResponse}
            accessibilityRole="button"
            accessibilityLabel="Arrêter la réponse"
          >
            <ActivityIndicator size="small" color={theme.color.text} />
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
            accessibilityLabel="Envoyer"
          >
            <Text style={styles.sendGlyph}>↑</Text>
          </Pressable>
        )}
      </View>

      {!props.microphoneAvailable && (
        // Un bouton qui ne fait rien est pire qu'un bouton absent : on explique
        // au lieu de laisser deviner.
        <Text style={styles.hint}>La dictée n'est pas disponible sur cet appareil.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.background,
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
    paddingBottom: theme.space(4),
    gap: theme.space(2),
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: theme.space(2) },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    color: theme.color.text,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
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
  micGlyph: { fontSize: 18 },
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
  sendGlyph: { color: theme.color.text, fontSize: 20, fontWeight: "700" },

  transcriptRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.danger,
  },
  transcript: { flex: 1, color: theme.color.textMuted, fontSize: 14 },
  linkButton: { paddingVertical: theme.space(1), paddingHorizontal: theme.space(2) },
  linkText: { color: theme.color.accent, fontSize: 13, fontWeight: "600" },
  hint: { color: theme.color.textFaint, fontSize: 12 },
});
