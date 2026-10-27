import { SectionList, StyleSheet, Text, View } from "react-native";
import { activeTasks, finishedTasks, type TaskView } from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { TaskCard } from "../components/cards.js";
import { type Theme, useThemedStyles } from "../theme/index.js";

/**
 * All tasks, grouped by active and completed status.
 *
 * "In progress" first, followed by "Completed" in reverse chronological order.
 */
export default function TasksScreen() {
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();
  const { state } = nexus;

  const running = activeTasks(state);
  const finished = finishedTasks(state);

  const sections: { title: string; data: TaskView[] }[] = [
    ...(running.length > 0 ? [{ title: "In progress", data: running }] : []),
    ...(finished.length > 0 ? [{ title: "Completed", data: finished }] : []),
  ];

  const deviceNameOf = (deviceId: string | null): string | undefined =>
    state.devices.find((device) => device.id === deviceId)?.name;

  return (
    <View style={styles.screen}>
      <SectionList
        sections={sections}
        keyExtractor={(task) => task.id}
        contentContainerStyle={styles.list}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>
            {section.title} · {section.data.length}
          </Text>
        )}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            {...(deviceNameOf(item.workerDeviceId) === undefined
              ? {}
              : { deviceName: deviceNameOf(item.workerDeviceId) })}
            onCancel={(taskId) => {
              void nexus.cancelTask(taskId);
            }}
          />
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No tasks yet. Ask NEXUS anything in the conversation.</Text>
        }
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.color.background },
    list: { padding: theme.space(6), flexGrow: 1 },
    sectionTitle: {
      color: theme.color.textFaint,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginTop: theme.space(6),
      marginBottom: theme.space(2),
    },
    empty: {
      color: theme.color.textMuted,
      fontSize: 15,
      lineHeight: 21,
      marginTop: theme.space(9),
    },
  });
