import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { activeTasks, type ApiDevice } from "@nexus/client-core";
import { Badge, Button, Card, ListRow, ResourceScreen, SectionHeader } from "../components/ui.js";
import type { PauseState, SatelliteView, VisualControlStatus } from "../lib/api-types.js";
import { useAppLock } from "../lib/app-lock.js";
import { failureMessage } from "../lib/errors.js";
import { formatRelative } from "../lib/format.js";
import { useNexus } from "../lib/nexus.js";
import { useAutoRefresh, useResource } from "../lib/use-resource.js";
import { newIdempotencyKey } from "../lib/uuid.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

/** Commands that take no parameter. The others need device-specific knowledge the API does not expose. */
const SATELLITE_ACTIONS: { command: string; label: string }[] = [
  { command: "system.ping", label: "Ping" },
  { command: "system.diagnostics", label: "Diagnostics" },
  { command: "system.capabilities", label: "Capabilities" },
];

interface RemoteData {
  pause: PauseState;
  devices: ApiDevice[];
  satellites: SatelliteView[];
  /** Administrator-only, and absent where no browser manager is configured. */
  visual: VisualControlStatus | undefined;
}

/**
 * Remote control.
 *
 * There is no "run X on device Y" call, and that is deliberate on the core: a
 * client hands over an instruction, and the planner, the selector and the
 * permission model decide. So this screen drives the fleet through that same
 * path, and every risky step still comes back as a confirmation. Only the
 * emergency stop and allowlisted satellite commands act directly.
 *
 * Each action passes the biometric gate when enabled, since an unlocked phone
 * should not by itself be able to reach someone's workstation.
 */
export default function RemoteScreen() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();
  const lock = useAppLock();
  const [target, setTarget] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();

  const resource = useResource<RemoteData>("remote", async () => {
    const [pause, devices, satellites, visual] = await Promise.all([
      nexus.mobile.pauseState(),
      nexus.api.listDevices(),
      nexus.mobile.satellites().catch(() => []),
      nexus.mobile.visualControl().catch(() => undefined),
    ]);
    return { pause, devices, satellites, visual };
  });
  useAutoRefresh(resource.reload, 15_000);

  const running = activeTasks(nexus.state);

  const run = async (reason: string, work: () => Promise<unknown>) => {
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

  const togglePause = (pause: PauseState) => {
    const next = !pause.paused;
    Alert.alert(
      next ? "Pause all of NEXUS?" : "Resume NEXUS?",
      next
        ? "No new task, agent or mission starts until you resume, on any device."
        : "Tasks, agents and missions can start again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: next ? "Pause" : "Resume",
          style: next ? "destructive" : "default",
          onPress: () => {
            void run(next ? "Pause NEXUS" : "Resume NEXUS", () =>
              nexus.mobile.setPaused(next, next ? "Paused from the mobile app" : undefined),
            );
          },
        },
      ],
    );
  };

  const sendInstruction = (data: RemoteData) => {
    const deviceId = nexus.session.deviceId;
    const text = instruction.trim();
    if (deviceId === null || text.length === 0) return;

    const device = data.devices.find((candidate) => candidate.id === target);
    const full = device === undefined ? text : `On ${device.name}: ${text}`;

    void run("Send an instruction to your devices", async () => {
      const task = await nexus.api.instruct({ instruction: full, originClientDeviceId: deviceId });
      setInstruction("");
      setSent(`Sent. NEXUS planned "${task.title}".`);
    });
  };

  return (
    <ResourceScreen resource={resource}>
      {(data) => {
        const workers = data.devices.filter(
          (device) =>
            device.trust === "TRUSTED" && device.role !== "CLIENT" && device.status === "ONLINE",
        );
        const canInstruct = !data.pause.paused && !nexus.devicePending;
        return (
          <>
            <Card style={data.pause.paused ? { borderColor: theme.color.warning } : {}}>
              <View style={styles.spread}>
                <Text style={styles.title}>Emergency stop</Text>
                <Badge
                  label={data.pause.paused ? "paused" : "running"}
                  tone={data.pause.paused ? "warn" : "ok"}
                />
              </View>
              <Text style={styles.muted}>
                {data.pause.paused
                  ? `Paused ${formatRelative(data.pause.since)}${data.pause.reason === null ? "" : `: ${data.pause.reason}`}`
                  : "Stops every new task, agent and mission at once."}
              </Text>
              <Button
                label={data.pause.paused ? "Resume NEXUS" : "Pause NEXUS"}
                variant={data.pause.paused ? "primary" : "danger"}
                icon={data.pause.paused ? "play" : "pause"}
                busy={busy}
                onPress={() => {
                  togglePause(data.pause);
                }}
              />
            </Card>

            <SectionHeader title="Instruct your devices" />
            <Card>
              <Text style={styles.muted}>
                NEXUS plans the work, checks permissions, and asks you to confirm anything risky.
              </Text>
              {workers.length > 0 && (
                <View style={styles.chips} accessibilityRole="radiogroup">
                  <Chip
                    label="Let NEXUS choose"
                    selected={target === undefined}
                    onPress={() => {
                      setTarget(undefined);
                    }}
                  />
                  {workers.map((device) => (
                    <Chip
                      key={device.id}
                      label={device.name}
                      selected={target === device.id}
                      onPress={() => {
                        setTarget(device.id);
                      }}
                    />
                  ))}
                </View>
              )}
              {workers.length === 0 && (
                <Text style={styles.warning}>
                  No worker is online. An instruction will wait or fail until one connects.
                </Text>
              )}
              <TextInput
                style={styles.input}
                value={instruction}
                onChangeText={setInstruction}
                placeholder="Run the test suite and tell me the result"
                placeholderTextColor={theme.color.textFaint}
                multiline
                maxLength={1_900}
                editable={canInstruct}
                accessibilityLabel="Instruction"
              />
              {sent !== undefined && <Text style={styles.muted}>{sent}</Text>}
              {!canInstruct && (
                <Text style={styles.warning}>
                  {data.pause.paused
                    ? "NEXUS is paused: resume it to send instructions."
                    : "This phone must be approved before it can send instructions."}
                </Text>
              )}
              <Button
                label="Send"
                variant="primary"
                icon="send"
                busy={busy}
                disabled={!canInstruct || instruction.trim().length === 0}
                onPress={() => {
                  sendInstruction(data);
                }}
              />
            </Card>

            {running.length > 0 && (
              <Card>
                <ListRow
                  icon="flash-outline"
                  title={`${String(running.length)} running`}
                  detail="See progress and cancel"
                  onPress={() => {
                    router.push("/tasks");
                  }}
                />
              </Card>
            )}

            {data.visual !== undefined && (
              <>
                <SectionHeader title="Browser control" />
                <Card>
                  <View style={styles.spread}>
                    <Text style={styles.title}>Visual sessions</Text>
                    <Badge
                      label={data.visual.paused ? "paused" : data.visual.active ? "active" : "idle"}
                      tone={data.visual.paused ? "warn" : data.visual.active ? "live" : "muted"}
                    />
                  </View>
                  <Button
                    label={data.visual.paused ? "Resume" : "Pause"}
                    disabled={busy}
                    onPress={() => {
                      const next = !(data.visual?.paused ?? false);
                      void run("Change browser control", () =>
                        nexus.mobile.setVisualControlPaused(next),
                      );
                    }}
                  />
                </Card>
              </>
            )}

            {data.satellites.length > 0 && <SectionHeader title="IoT satellites" />}
            {data.satellites.map((satellite) => (
              <Card key={satellite.deviceId}>
                <View style={styles.spread}>
                  <Text style={styles.title}>{satellite.name}</Text>
                  <Badge status={satellite.online ? "online" : "offline"} />
                </View>
                <Text style={styles.muted}>Seen {formatRelative(satellite.lastSeenAt)}</Text>
                <View style={styles.chips}>
                  {SATELLITE_ACTIONS.map((action) => (
                    <Button
                      key={action.command}
                      label={action.label}
                      disabled={busy || !satellite.online}
                      onPress={() => {
                        void run(`Send ${action.label} to ${satellite.name}`, async () => {
                          await nexus.mobile.sendSatelliteCommand(
                            satellite.deviceId,
                            action.command,
                            {},
                            newIdempotencyKey(),
                          );
                          // Results are not readable by clients yet: "queued" is all that is known.
                          setSent(`${action.label} queued for ${satellite.name}.`);
                        });
                      }}
                    />
                  ))}
                </View>
              </Card>
            ))}
          </>
        );
      }}
    </ResourceScreen>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    spread: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    title: { color: theme.color.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
    muted: { color: theme.color.textMuted, fontSize: 13, lineHeight: 18 },
    warning: { color: theme.color.warning, fontSize: 13, lineHeight: 18 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(3) },
    chip: {
      paddingHorizontal: theme.space(5),
      minHeight: 36,
      justifyContent: "center",
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: theme.color.border,
      maxWidth: "100%",
    },
    chipSelected: { backgroundColor: theme.color.accentMuted, borderColor: theme.color.accent },
    chipText: { color: theme.color.textMuted, fontSize: 13, fontWeight: "600" },
    chipTextSelected: { color: theme.color.accent },
    input: {
      backgroundColor: theme.color.backgroundSunken,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      color: theme.color.text,
      fontSize: 15,
      minHeight: 80,
      padding: theme.space(5),
      textAlignVertical: "top",
    },
  });
