import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  Badge,
  Card,
  ProgressBar,
  ResourceScreen,
  SectionHeader,
  StateView,
} from "../../components/ui.js";
import type { Mission, OrchestratedMission } from "../../lib/api-types.js";
import { formatRelative, humanize, missionProgress, readableJson } from "../../lib/format.js";
import { useNexus } from "../../lib/nexus.js";
import { useAutoRefresh, useResource } from "../../lib/use-resource.js";
import { useTheme } from "../../theme/index.js";

interface MissionDetail {
  /** Orchestrator view: the final answer. Absent for missions it did not start. */
  outcome: OrchestratedMission | undefined;
  /** Engine view: per-task state. Administrator-only. */
  mission: Mission | undefined;
}

export default function MissionScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const { id } = useLocalSearchParams<{ id: string }>();

  const resource = useResource<MissionDetail>(`mission:${id}`, async () => {
    const [outcome, control] = await Promise.allSettled([
      nexus.mobile.getMission(id),
      nexus.mobile.missionControl(),
    ]);
    const mission =
      control.status === "fulfilled"
        ? control.value.missions.find((candidate) => candidate.id === id)
        : undefined;
    if (outcome.status === "rejected" && mission === undefined) throw outcome.reason;
    return { outcome: outcome.status === "fulfilled" ? outcome.value : undefined, mission };
  });
  useAutoRefresh(resource.reload, 5_000);

  const text = { color: theme.color.text, fontSize: 14, lineHeight: 20 } as const;
  const muted = { color: theme.color.textMuted, fontSize: 12 } as const;

  return (
    <ResourceScreen resource={resource}>
      {({ outcome, mission }) => {
        const tasks = mission?.tasks ?? [];
        const progress = missionProgress(tasks);
        const percent =
          outcome !== undefined && outcome.totalTasks > 0
            ? Math.round((outcome.completedTasks / outcome.totalTasks) * 100)
            : progress.percent;
        return (
          <>
            <Card>
              <Text style={{ ...text, fontSize: 17, fontWeight: "600" }}>
                {outcome?.title ?? mission?.title ?? "Mission"}
              </Text>
              <Badge status={outcome?.state ?? mission?.state ?? "unknown"} />
              <ProgressBar percent={percent} />
              {outcome !== undefined && outcome.profiles.length > 0 && (
                <Text style={muted}>Agents: {outcome.profiles.join(", ")}</Text>
              )}
            </Card>

            {outcome?.error !== null && outcome?.error !== undefined && (
              <Card>
                <SectionHeader title="Error" />
                <Text style={{ ...text, color: theme.color.danger }}>{outcome.error}</Text>
              </Card>
            )}

            {outcome?.response !== null && outcome?.response !== undefined && (
              <Card>
                <SectionHeader title="Result" />
                <Text style={text} selectable>
                  {outcome.response}
                </Text>
              </Card>
            )}

            {tasks.length > 0 && <SectionHeader title="Tasks" />}
            {tasks.map((task) => {
              const result = readableJson(task.result_json);
              const error = readableJson(task.error_json);
              return (
                <Card key={task.id}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ ...text, flex: 1, fontWeight: "600" }} numberOfLines={2}>
                      {humanize(task.task_key)}
                    </Text>
                    <Badge status={task.state} />
                  </View>
                  <Text style={muted}>
                    {task.profile_key}
                    {task.attempts.length > 1 ? ` · ${String(task.attempts.length)} attempts` : ""}
                  </Text>
                  {error !== null && (
                    <Text style={{ ...muted, color: theme.color.danger }}>{error}</Text>
                  )}
                  {result !== null && (
                    <Text style={{ ...text, fontSize: 13 }} numberOfLines={12} selectable>
                      {result}
                    </Text>
                  )}
                </Card>
              );
            })}

            {mission !== undefined && (
              <Text style={muted}>Updated {formatRelative(mission.updated_at)}</Text>
            )}
            {outcome === undefined && mission === undefined && (
              <StateView icon="search-outline" title="Mission not found" />
            )}
          </>
        );
      }}
    </ResourceScreen>
  );
}
