import { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { ApiDevice } from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { theme } from "../theme/index.js";

/**
 * Fleet device management.
 *
 * Approves newly paired devices, revokes lost devices, and inspects reported capabilities.
 * Revocation requires explicit confirmation as it is irreversible.
 */
export default function DevicesScreen() {
  const nexus = useNexus();
  const [devices, setDevices] = useState<ApiDevice[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = async () => {
    setRefreshing(true);
    try {
      setDevices(await nexus.api.listDevices());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load devices.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const confirmRevoke = (device: ApiDevice) => {
    Alert.alert(
      `Revoke ${device.name}?`,
      "The device will no longer execute tasks or receive events. " +
        "Revocation is permanent: you will need to pair it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => {
            void nexus.api
              .revokeDevice(device.id)
              .then(load)
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Revocation failed.");
              });
          },
        },
      ],
    );
  };

  return (
    <View style={styles.screen}>
      {error !== undefined && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={devices}
        keyExtractor={(device) => device.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void load();
            }}
            tintColor={theme.color.textMuted}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.header}>
              <View style={styles.nameRow}>
                <View
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor:
                        item.status === "ONLINE" ? theme.color.success : theme.color.textFaint,
                    },
                  ]}
                />
                <Text style={styles.name}>{item.name}</Text>
              </View>
              <Text style={styles.role}>{roleLabel(item.role)}</Text>
            </View>

            <Text style={styles.meta}>
              {item.type} · {statusLabel(item.status)} · {trustLabel(item.trust)}
            </Text>

            <Text style={styles.meta}>
              {item.health.activeTasks}/{item.health.maxConcurrentTasks} task
              {item.health.maxConcurrentTasks > 1 ? "s" : ""}
              {item.health.batteryPercent === undefined
                ? ""
                : ` · battery ${String(item.health.batteryPercent)}%${
                    item.health.onBattery === true ? "" : " (charging)"
                  }`}
            </Text>

            {item.capabilities.length > 0 && (
              <View style={styles.capabilities}>
                {item.capabilities.slice(0, 8).map((capability) => (
                  <Text key={capability} style={styles.capabilityChip}>
                    {capability}
                  </Text>
                ))}
                {item.capabilities.length > 8 && (
                  <Text style={styles.capabilityChip}>+{item.capabilities.length - 8}</Text>
                )}
              </View>
            )}

            <Text style={styles.faint}>
              {item.lastSeenAt === null ? "never seen" : `seen ${formatRelative(item.lastSeenAt)}`}
            </Text>

            <View style={styles.actions}>
              {item.trust === "PENDING" && (
                <Pressable
                  style={styles.approve}
                  onPress={() => {
                    void nexus.api.trustDevice(item.id).then(load);
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.approveText}>Approve</Text>
                </Pressable>
              )}

              {item.trust !== "REVOKED" && (
                <Pressable
                  style={styles.revoke}
                  onPress={() => {
                    confirmRevoke(item);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Revoke ${item.name}`}
                >
                  <Text style={styles.revokeText}>Revoke</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No registered devices. Pair your computer or phone from their NEXUS client.
          </Text>
        }
      />
    </View>
  );
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    CLIENT: "client",
    WORKER: "worker",
    BOTH: "client & worker",
  };
  return labels[role] ?? role;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ONLINE: "online",
    OFFLINE: "offline",
    DEGRADED: "degraded",
    REVOKED: "revoked",
  };
  return labels[status] ?? status;
}

function trustLabel(trust: string): string {
  const labels: Record<string, string> = {
    PENDING: "pending approval",
    TRUSTED: "approved",
    REVOKED: "revoked",
  };
  return labels[trust] ?? trust;
}

function formatRelative(iso: string): string {
  const seen = new Date(iso).getTime();
  if (Number.isNaN(seen)) return "unknown date";

  const minutes = Math.round((Date.now() - seen) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  if (minutes < 1_440) return `${String(Math.round(minutes / 60))}h ago`;
  return `${String(Math.round(minutes / 1_440))}d ago`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.background },
  list: { padding: theme.space(4), gap: theme.space(3), flexGrow: 1 },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(4),
    gap: theme.space(2),
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  nameRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2), flex: 1 },
  statusDot: { width: 9, height: 9, borderRadius: theme.radius.pill },
  name: { color: theme.color.text, fontSize: 16, fontWeight: "600" },
  role: { color: theme.color.textFaint, fontSize: 12 },
  meta: { color: theme.color.textMuted, fontSize: 13 },
  faint: { color: theme.color.textFaint, fontSize: 12 },
  capabilities: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(1.5) },
  capabilityChip: {
    color: theme.color.textMuted,
    fontSize: 11,
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(2),
    paddingVertical: theme.space(1),
  },
  actions: { flexDirection: "row", gap: theme.space(2), marginTop: theme.space(1) },
  approve: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2.5),
  },
  approveText: { color: theme.color.text, fontSize: 13, fontWeight: "600" },
  revoke: {
    borderWidth: 1,
    borderColor: theme.color.danger,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2.5),
  },
  revokeText: { color: theme.color.danger, fontSize: 13, fontWeight: "600" },
  error: {
    color: theme.color.danger,
    fontSize: 14,
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(3),
  },
  empty: { color: theme.color.textMuted, fontSize: 15, lineHeight: 21, marginTop: theme.space(8) },
});
