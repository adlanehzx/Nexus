import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ConfirmationView, MessageView, TaskView, ToolCallView } from "@nexus/client-core";
import { riskColor, statusColor, statusLabel, theme } from "../theme/index.js";

/**
 * Les cartes de la conversation.
 *
 * Une règle traverse ce fichier : **une carte montre ce qui se passe, jamais les
 * arguments bruts**. Un `terminal.execute` affiche « Lancer les tests sur le
 * poste fixe », pas la ligne de commande — le serveur n'envoie d'ailleurs que le
 * résumé, et c'est délibéré.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Message
// ─────────────────────────────────────────────────────────────────────────────

export function MessageBubble({ message }: { message: MessageView }) {
  const mine = message.role === "user";

  return (
    <View style={[styles.bubbleRow, mine ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={styles.bubbleText}>{message.content}</Text>

        {/* Un curseur pendant le flux : l'utilisateur voit que ça avance. */}
        {message.streaming && <Text style={styles.cursor}>▌</Text>}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tâche
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

      {/* L'exécutant est nommé : savoir *où* une commande tourne fait partie de
          ce que l'utilisateur a le droit de voir. */}
      {deviceName !== undefined && <Text style={styles.cardMeta}>sur {deviceName}</Text>}

      {task.label !== null && (
        <Text style={styles.cardMeta} numberOfLines={1}>
          {task.label}
        </Text>
      )}

      {running && (
        <View style={styles.progressTrack}>
          {/* React Native type une largeur en pourcentage comme `${number}%` ;
              une chaîne construite doit donc être annoncée comme telle. */}
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
            accessibilityLabel={`Annuler ${task.title}`}
          >
            <Text style={styles.linkText}>Annuler</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Appel d'outil
// ─────────────────────────────────────────────────────────────────────────────

export function ToolCard({ call }: { call: ToolCallView }) {
  return (
    <View style={[styles.card, styles.toolCard]}>
      <View style={styles.cardHeader}>
        <Text style={styles.toolName}>{call.tool}</Text>
        <Text style={[styles.riskChip, { color: riskColor(call.riskLevel) }]}>
          {call.riskLevel}
        </Text>
      </View>

      {/* Le résumé, jamais les arguments : le serveur n'envoie que celui-là. */}
      <Text style={styles.cardMeta} numberOfLines={3}>
        {call.summary}
      </Text>

      <View style={styles.cardFooter}>
        {call.status === "running" ? (
          <View style={styles.inline}>
            <ActivityIndicator size="small" color={theme.color.accent} />
            <Text style={styles.cardFaint}>{call.label ?? "en cours"}</Text>
          </View>
        ) : (
          <Text style={[styles.cardFaint, { color: statusColor(call.status) }]}>
            {call.status === "succeeded" ? "terminé" : "échoué"}
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
 * Demande de confirmation.
 *
 * Trois protections contre l'approbation accidentelle, et aucune n'est
 * décorative :
 *
 *  1. **Approuver est à droite, Annuler à gauche.** Le pouce d'une main droite
 *     tombe naturellement à droite ; on inverse donc pour les actions à haut
 *     risque, où le geste facile doit être le geste sûr.
 *  2. **Au-dessus de MEDIUM, il faut deux appuis.** Le premier arme, le second
 *     confirme. Un appui isolé ne peut pas lancer une commande destructrice.
 *  3. **Le risque est écrit en toutes lettres**, coloré comme partout ailleurs
 *     dans NEXUS.
 */
export function ConfirmationCard({
  confirmation,
  onAnswer,
}: {
  confirmation: ConfirmationView;
  onAnswer: (id: string, decision: "approved" | "rejected") => void;
}) {
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
      <Text style={styles.confirmIntro}>NEXUS demande à :</Text>
      <Text style={styles.confirmAction}>{confirmation.action}</Text>

      {confirmation.description !== confirmation.action && (
        <Text style={styles.cardMeta} numberOfLines={4}>
          {confirmation.description}
        </Text>
      )}

      <View style={styles.riskRow}>
        <Text style={styles.cardFaint}>Risque</Text>
        <Text style={[styles.riskValue, { color: riskColor(confirmation.riskLevel) }]}>
          {confirmation.riskLevel}
        </Text>
      </View>

      {armed && (
        <Text style={styles.armedNotice}>
          Appuyez à nouveau sur « Approuver » pour confirmer cette action à risque{" "}
          {confirmation.riskLevel}.
        </Text>
      )}

      <View style={styles.confirmActions}>
        {/* Refuser occupe la position du pouce : le geste facile est le geste sûr. */}
        <Pressable
          style={[styles.button, styles.buttonNeutral]}
          onPress={() => {
            onAnswer(confirmation.id, "rejected");
          }}
          accessibilityRole="button"
          accessibilityLabel="Refuser cette action"
        >
          <Text style={styles.buttonNeutralText}>Refuser</Text>
        </Pressable>

        <Pressable
          style={[
            styles.button,
            armed ? styles.buttonArmed : styles.buttonApprove,
            { borderColor: riskColor(confirmation.riskLevel) },
          ]}
          onPress={approve}
          accessibilityRole="button"
          accessibilityLabel={
            armed ? "Confirmer définitivement cette action" : "Approuver cette action"
          }
        >
          <Text style={styles.buttonApproveText}>{armed ? "Confirmer" : "Approuver"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Erreur
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
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText} numberOfLines={3}>
        {message}
      </Text>

      <View style={styles.inline}>
        {onRetry !== undefined && (
          <Pressable style={styles.linkButton} onPress={onRetry} accessibilityRole="button">
            <Text style={styles.linkText}>Réessayer</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.linkButton}
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Masquer l'erreur"
        >
          <Text style={styles.bannerDismiss}>Masquer</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Bandeau d'état de connexion. Visible seulement quand ça ne va pas. */
export function ConnectionBanner({ connection, online }: { connection: string; online: boolean }) {
  if (online && connection === "connected") return null;

  const message = !online
    ? "Hors ligne — NEXUS reprendra dès le retour du réseau."
    : connection === "reconnecting"
      ? "Reconnexion à NEXUS…"
      : "Connexion à NEXUS…";

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
    : date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${String(Math.round(ms / 60_000))} min`;
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: "row", marginVertical: theme.space(1) },
  rowRight: { justifyContent: "flex-end" },
  rowLeft: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "85%",
    paddingVertical: theme.space(2.5),
    paddingHorizontal: theme.space(3.5),
    borderRadius: theme.radius.lg,
  },
  bubbleMine: { backgroundColor: theme.color.accent },
  bubbleTheirs: { backgroundColor: theme.color.surfaceRaised },
  bubbleText: { color: theme.color.text, fontSize: 16, lineHeight: 22 },
  cursor: { color: theme.color.textMuted, fontSize: 14 },

  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(3.5),
    marginVertical: theme.space(1.5),
    gap: theme.space(1.5),
  },
  toolCard: { backgroundColor: theme.color.surfaceRaised },
  confirmCard: { borderWidth: 2 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", gap: theme.space(2) },
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
  confirmActions: { flexDirection: "row", gap: theme.space(3), marginTop: theme.space(1) },
  button: {
    flex: 1,
    paddingVertical: theme.space(3.5),
    borderRadius: theme.radius.md,
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
    padding: theme.space(3),
    borderRadius: theme.radius.sm,
    gap: theme.space(1.5),
  },
  bannerText: { color: theme.color.text, fontSize: 14, lineHeight: 19 },
  bannerDismiss: { color: theme.color.textMuted, fontSize: 13 },

  connectionBanner: {
    backgroundColor: theme.color.surfaceRaised,
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(4),
    alignItems: "center",
  },
  connectionText: { color: theme.color.textMuted, fontSize: 13 },

  linkButton: { paddingVertical: theme.space(1), paddingHorizontal: theme.space(2) },
  linkText: { color: theme.color.accent, fontSize: 13, fontWeight: "600" },
  inline: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
});
