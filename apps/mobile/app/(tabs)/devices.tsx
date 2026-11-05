import { Alert, Text, View } from "react-native";
import { router } from "expo-router";
import type { ApiDevice } from "@nexus/client-core";
import {
  Badge,
  Button,
  Card,
  ListRow,
  ResourceScreen,
  SectionHeader,
  StateView,
} from "../../components/ui.js";
import type { SatelliteView } from "../../lib/api-types.js";
import { failureMessage } from "../../lib/errors.js";
import { formatRelative } from "../../lib/format.js";
import { useNexus } from "../../lib/nexus.js";
import { useAutoRefresh, useResource } from "../../lib/use-resource.js";
import { useTheme } from "../../theme/index.js";

interface FleetData {
  devices: ApiDevice[];
  satellites: SatelliteView[];
}

const GROUPS: { title: string; matches: (device: ApiDevice) => boolean }[] = [
  {
    title: "Computers",
    matches: (device) => ["WINDOWS_PC", "MAC", "LINUX"].includes(device.type),
  },
  {
    title: "Phones and Android workers",
    matches: (device) => ["ANDROID", "IPHONE"].includes(device.type),
  },
];

/**
 * The fleet at a glance, by kind of machine.
 *
 * Pending approvals come first: a device waiting is the one thing here that
 * needs a person. Everything else about a device is one tap further.
 */
export default function DevicesScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const resource = useResource<FleetData>("fleet", async () => {
    const [devices, satellites] = await Promise.all([
      nexus.api.listDevices(),
      // No satellites configured is the normal case, not a failure of this screen.
      nexus.mobile.satellites().catch(() => []),
    ]);
    return { devices, satellites };
  });
  useAutoRefresh(resource.reload, 20_000);

  const approve = (device: ApiDevice) => {
    Alert.alert(
      `Approve ${device.name}?`,
      "It joins your fleet and can receive tasks within the permissions you grant it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          onPress: () => {
            nexus.api
              .trustDevice(device.id)
              .then(resource.reload)
              .catch((cause: unknown) => {
                Alert.alert("Not approved", failureMessage(cause));
              });
          },
        },
      ],
    );
  };

  return (
    <ResourceScreen resource={resource}>
      {({ devices, satellites }) => {
        const active = devices.filter((device) => device.trust !== "REVOKED");
        const pending = active.filter((device) => device.trust === "PENDING");
        const trusted = active.filter((device) => device.trust !== "PENDING");
        const other = trusted.filter((device) => !GROUPS.some((group) => group.matches(device)));

        return (
          <>
            <Button
              label="Remote control"
              icon="game-controller-outline"
              onPress={() => {
                router.push("/remote");
              }}
            />

            {pending.length > 0 && <SectionHeader title="Waiting for approval" />}
            {pending.map((device) => (
              <Card key={device.id}>
                <ListRow
                  icon="time-outline"
                  title={device.name}
                  detail={`${device.type} · ${device.platform}`}
                  trailing={
                    device.id === nexus.session.deviceId ? (
                      <Badge label="this phone" tone="warn" />
                    ) : (
                      <Button
                        label="Approve"
                        variant="primary"
                        onPress={() => {
                          approve(device);
                        }}
                      />
                    )
                  }
                />
              </Card>
            ))}

            {GROUPS.map((group) => {
              const members = trusted.filter(group.matches);
              if (members.length === 0) return null;
              return (
                <View key={group.title} style={{ gap: theme.space(4) }}>
                  <SectionHeader title={group.title} />
                  {members.map((device) => (
                    <DeviceCard key={device.id} device={device} />
                  ))}
                </View>
              );
            })}

            {other.length > 0 && <SectionHeader title="Other" />}
            {other.map((device) => (
              <DeviceCard key={device.id} device={device} />
            ))}

            {satellites.length > 0 && <SectionHeader title="IoT satellites" />}
            {satellites.map((satellite) => (
              <Card key={satellite.deviceId}>
                <ListRow
                  icon="radio-outline"
                  title={satellite.name}
                  detail={`${String(satellite.capabilities.length)} capabilities · seen ${formatRelative(satellite.lastSeenAt)}`}
                  trailing={<Badge status={satellite.online ? "online" : "offline"} />}
                  onPress={() => {
                    router.push("/remote");
                  }}
                />
              </Card>
            ))}

            {active.length === 0 && satellites.length === 0 && (
              <StateView
                icon="hardware-chip-outline"
                title="No devices"
                message="Pair a computer or phone from its NEXUS client."
              />
            )}
          </>
        );
      }}
    </ResourceScreen>
  );
}

function DeviceCard({ device }: { device: ApiDevice }) {
  const nexus = useNexus();
  const self = device.id === nexus.session.deviceId;
  // The core tracks presence for workers only. This phone knows its own connection.
  const online = device.status === "ONLINE" || (self && nexus.state.connection === "connected");
  const battery = device.health.batteryPercent;
  const load = `${String(device.health.activeTasks)}/${String(device.health.maxConcurrentTasks)} tasks`;
  return (
    <Card style={{ paddingVertical: 8 }}>
      <ListRow
        title={self ? `${device.name} (this phone)` : device.name}
        detail={[
          load,
          battery === undefined ? null : `${String(battery)}% battery`,
          online ? null : `seen ${formatRelative(device.lastSeenAt)}`,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        trailing={<Badge status={online ? "ONLINE" : device.status} />}
        onPress={() => {
          router.push(`/device/${device.id}`);
        }}
      />
      <DeviceWarning device={device} />
    </Card>
  );
}

function DeviceWarning({ device }: { device: ApiDevice }) {
  const theme = useTheme();
  if (device.status !== "DEGRADED") return null;
  return (
    <Text style={{ color: theme.color.warning, fontSize: 12 }}>
      Reporting degraded health. Open it for details.
    </Text>
  );
}
