import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useNexus } from "../lib/nexus.js";
import { theme } from "../theme/index.js";

/**
 * Les notifications.
 *
 * L'état « lu » vit **au centre**, pas sur l'appareil : marquer une alerte comme
 * lue sur l'iPhone la marque aussi sur le portable. C'est ce qui évite de lire
 * deux fois la même chose.
 */
export default function NotificationsScreen() {
  const nexus = useNexus();

  return (
    <View style={styles.screen}>
      <FlatList
        data={nexus.state.notifications}
        keyExtractor={(notification) => notification.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, item.readAt === null && styles.unread]}
            onPress={() => void nexus.markNotificationRead(item.id)}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. ${item.readAt === null ? "Non lue" : "Lue"}`}
          >
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <View style={[styles.dot, { backgroundColor: severityColor(item.severity) }]} />
            </View>
            <Text style={styles.body} numberOfLines={3}>
              {item.body}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>Aucune notification.</Text>}
      />
    </View>
  );
}

function severityColor(severity: string): string {
  if (severity === "error") return theme.color.danger;
  if (severity === "warning") return theme.color.warning;
  return theme.color.accent;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.background },
  list: { padding: theme.space(4), gap: theme.space(2), flexGrow: 1 },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(3.5),
    gap: theme.space(1.5),
  },
  unread: { borderColor: theme.color.accent },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.space(2),
  },
  title: { color: theme.color.text, fontSize: 15, fontWeight: "600", flex: 1 },
  dot: { width: 8, height: 8, borderRadius: theme.radius.pill },
  body: { color: theme.color.textMuted, fontSize: 13, lineHeight: 18 },
  empty: { color: theme.color.textMuted, fontSize: 15, marginTop: theme.space(8) },
});
