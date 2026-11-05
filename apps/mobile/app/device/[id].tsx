import { useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  Badge,
  Button,
  Card,
  ListRow,
  ResourceScreen,
  SectionHeader,
  Stat,
  StatRow,
} from "../../components/ui.js";
import { useAppLock } from "../../lib/app-lock.js";
import { failureMessage } from "../../lib/errors.js";
import { formatMegabytes, formatRelative } from "../../lib/format.js";
import { useNexus } from "../../lib/nexus.js";
import { useAutoRefresh, useResource } from "../../lib/use-resource.js";
import { useTheme } from "../../theme/index.js";

/** One machine: its health, what it may do, and how to take it out of service. */
export default function DeviceScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const lock = useAppLock();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [busy, setBusy] = useState(false);
  const resource = useResource(`device:${id}`, () => nexus.mobile.getDevice(id));
  useAutoRefresh(resource.reload, 15_000);

  const guarded = async (reason: string, work: () => Promise<unknown>) => {
    if (!(await lock.confirmRemoteAction(reason))) return;
    setBusy(true);
    try {
      await work();
      await resource.reload();
    } catch (cause) {
      Alert.alert("Action failed", failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResourceScreen resource={resource}>
      {(device) => {
        const self = device.id === nexus.session.deviceId;
        const cpu = device.health.cpuLoad;
        return (
          <>
            <Card>
              <Text style={{ color: theme.color.text, fontSize: 18, fontWeight: "600" }}>
                {device.name}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Badge status={device.status} />
                <Badge status={device.trust} />
                {device.authenticated ? <Badge label="connected" tone="ok" /> : null}
              </View>
              <Text style={{ color: theme.color.textMuted, fontSize: 12 }}>
                {device.type} · {device.platform} · {device.role.toLowerCase()}
                {device.agentVersion === null ? "" : ` · v${device.agentVersion}`}
              </Text>
              <Text style={{ color: theme.color.textFaint, fontSize: 12 }}>
                Last heartbeat {formatRelative(device.lastHeartbeatAt)}
              </Text>
            </Card>

            <StatRow>
              <Stat
                label="Tasks"
                value={`${String(device.health.activeTasks)}/${String(device.health.maxConcurrentTasks)}`}
              />
              <Stat label="CPU" value={cpu === null ? "—" : `${String(Math.round(cpu * 100))}%`} />
              <Stat label="Memory free" value={formatMegabytes(device.health.memoryFreeMb)} />
            </StatRow>
            <StatRow>
              <Stat label="Disk free" value={formatMegabytes(device.health.diskFreeMb)} />
              <Stat
                label={device.health.onBattery === true ? "On battery" : "Battery"}
                value={
                  device.health.batteryPercent === null
                    ? "—"
                    : `${String(device.health.batteryPercent)}%`
                }
              />
              <Stat
                label="Latency"
                value={
                  device.health.latencyMs === null ? "—" : `${String(device.health.latencyMs)} ms`
                }
              />
            </StatRow>

            {device.capabilities.length > 0 && <SectionHeader title="Permissions" />}
            {device.capabilities.length > 0 && (
              <Card>
                <Text style={{ color: theme.color.textMuted, fontSize: 12, lineHeight: 17 }}>
                  What this device may be asked to do. Removing a permission takes effect on its
                  next task.
                </Text>
                {device.capabilities.map((capability) => {
                  const granted = device.grantedPermissions.includes(capability.name);
                  return (
                    <ListRow
                      key={capability.name}
                      title={capability.name}
                      {...(capability.description.length === 0
                        ? {}
                        : { detail: capability.description })}
                      trailing={
                        <Switch
                          value={granted}
                          disabled={busy}
                          accessibilityLabel={`Allow ${capability.name}`}
                          onValueChange={(next) => {
                            void guarded(`Change permissions of ${device.name}`, () =>
                              nexus.api.setDevicePermissions(
                                device.id,
                                next
                                  ? [...device.grantedPermissions, capability.name]
                                  : device.grantedPermissions.filter(
                                      (name) => name !== capability.name,
                                    ),
                              ),
                            );
                          }}
                        />
                      }
                    />
                  );
                })}
              </Card>
            )}

            <SectionHeader title="Actions" />
            {device.trust === "PENDING" && !self && (
              <Button
                label="Approve this device"
                variant="primary"
                busy={busy}
                onPress={() => {
                  void guarded(`Approve ${device.name}`, () => nexus.api.trustDevice(device.id));
                }}
              />
            )}
            {!self && device.authenticated && (
              <Button
                label="Disconnect now"
                icon="power-outline"
                disabled={busy}
                onPress={() => {
                  Alert.alert(
                    `Disconnect ${device.name}?`,
                    "Its open sessions close. It stays paired and can sign in again.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Disconnect",
                        style: "destructive",
                        onPress: () => {
                          void guarded(`Disconnect ${device.name}`, () =>
                            nexus.mobile.disconnectDevice(device.id),
                          );
                        },
                      },
                    ],
                  );
                }}
              />
            )}
            {!self && device.trust !== "REVOKED" && (
              <Button
                label="Revoke"
                variant="danger"
                icon="ban-outline"
                disabled={busy}
                onPress={() => {
                  Alert.alert(
                    `Revoke ${device.name}?`,
                    "It will no longer execute tasks or receive events. Revocation is permanent: you will need to pair it again.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Revoke",
                        style: "destructive",
                        onPress: () => {
                          void guarded(`Revoke ${device.name}`, async () => {
                            await nexus.api.revokeDevice(device.id);
                            router.back();
                          });
                        },
                      },
                    ],
                  );
                }}
              />
            )}
          </>
        );
      }}
    </ResourceScreen>
  );
}
