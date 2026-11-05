import { useCallback, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { failureMessage } from "../lib/errors.js";
import { formatRelative } from "../lib/format.js";
import {
  notificationPermission,
  requestNotificationPermission,
  type PermissionState,
} from "../lib/notifications.js";
import { Button } from "../components/ui.js";
import { useNexus } from "../lib/nexus.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

/**
 * Notifications view.
 *
 * Read state is synchronized with the server: marking a notification as read
 * on mobile updates all attached clients.
 */
export default function NotificationsScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [permission, setPermission] = useState<PermissionState>("granted");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const notifications = await nexus.api.listNotifications();
      nexus.hydrateNotifications(notifications);
      setError(undefined);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }, [nexus.api, nexus.hydrateNotifications]);

  useFocusEffect(
    useCallback(() => {
      void load();
      void notificationPermission().then(setPermission);
    }, [load]),
  );

  return (
    <View style={styles.screen}>
      {permission !== "granted" && permission !== "unavailable" && (
        <View style={styles.banner}>
          <Text style={styles.body}>
            System notifications are off. You only see events while the app is open.
          </Text>
          <Button
            label={permission === "denied" ? "Open system settings" : "Turn on"}
            onPress={() => {
              if (permission === "denied") void Linking.openSettings();
              else void requestNotificationPermission().then(setPermission);
            }}
          />
        </View>
      )}
      {error !== undefined && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={nexus.state.notifications}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load()}
            tintColor={theme.color.textMuted}
          />
        }
        keyExtractor={(notification) => notification.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, item.readAt === null && styles.unread]}
            onPress={() => void nexus.markNotificationRead(item.id)}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. ${item.readAt === null ? "Unread" : "Read"}`}
          >
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <View
                style={[styles.dot, { backgroundColor: severityColor(item.severity, theme) }]}
              />
            </View>
            <Text style={styles.body} numberOfLines={3}>
              {item.body}
            </Text>
            <Text style={styles.time}>{formatRelative(item.createdAt)}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No notifications.</Text>}
      />
    </View>
  );
}

function severityColor(severity: string, theme: Theme): string {
  if (severity === "error") return theme.color.danger;
  if (severity === "warning") return theme.color.warning;
  return theme.color.accent;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.color.background },
    list: { padding: theme.space(6), gap: theme.space(4), flexGrow: 1 },
    card: {
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      padding: theme.space(6),
      gap: theme.space(3),
    },
    unread: { borderColor: theme.color.accent },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: theme.space(4),
    },
    title: { color: theme.color.text, fontSize: 15, fontWeight: "600", flex: 1 },
    dot: { width: 8, height: 8, borderRadius: theme.radius.pill },
    body: { color: theme.color.textMuted, fontSize: 13, lineHeight: 18 },
    time: { color: theme.color.textFaint, fontSize: 11 },
    banner: {
      gap: theme.space(4),
      margin: theme.space(6),
      marginBottom: 0,
      padding: theme.space(5),
      borderRadius: theme.radius.lg,
      backgroundColor: theme.color.surface,
    },
    error: {
      color: theme.color.danger,
      fontSize: 13,
      paddingHorizontal: theme.space(6),
      paddingTop: theme.space(4),
    },
    empty: { color: theme.color.textMuted, fontSize: 15, marginTop: theme.space(9) },
  });
