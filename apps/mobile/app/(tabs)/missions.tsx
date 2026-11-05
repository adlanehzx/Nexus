import { Alert, View } from "react-native";
import { Text } from "react-native";
import { router } from "expo-router";
import { activeTasks, pendingConfirmations } from "@nexus/client-core";
import { ConfirmationCard } from "../../components/cards.js";
import {
  Badge,
  Button,
  Card,
  FailureView,
  ListRow,
  ProgressBar,
  ResourceScreen,
  SectionHeader,
  StateView,
} from "../../components/ui.js";
import { failureMessage, describeFailure, type Failure } from "../../lib/errors.js";
import { formatRelative, missionProgress } from "../../lib/format.js";
import type { MissionControlSection } from "../../lib/api-types.js";
import { useNexus } from "../../lib/nexus.js";
import { useAutoRefresh, useResource } from "../../lib/use-resource.js";
import { useTheme } from "../../theme/index.js";

interface MissionsData {
  control: MissionControlSection | undefined;
  /** Kept apart: an account without admin rights still has approvals to answer. */
  controlFailure: Failure | undefined;
}

/**
 * Mission Control, reduced to what a phone is for: what needs me, what is
 * moving, what finished. Authoring schedules stays on the dashboard.
 */
export default function MissionsScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const resource = useResource<MissionsData>("missions", async () => {
    try {
      return { control: await nexus.mobile.missionControl(), controlFailure: undefined };
    } catch (cause) {
      return { control: undefined, controlFailure: describeFailure(cause) };
    }
  });
  useAutoRefresh(resource.reload, 15_000);

  const confirmations = pendingConfirmations(nexus.state);
  const running = activeTasks(nexus.state);

  const setPaused = (scheduleId: string, paused: boolean) => {
    nexus.mobile
      .setSchedulePaused(scheduleId, paused)
      .then(resource.reload)
      .catch((cause: unknown) => {
        Alert.alert("Schedule not changed", failureMessage(cause));
      });
  };

  return (
    <ResourceScreen resource={resource}>
      {({ control, controlFailure }) => (
        <>
          {confirmations.length > 0 && (
            <View>
              <SectionHeader title={`Needs your approval · ${String(confirmations.length)}`} />
              {confirmations.map((confirmation) => (
                <ConfirmationCard
                  key={confirmation.id}
                  confirmation={confirmation}
                  onAnswer={(id, decision) => void nexus.answerConfirmation(id, decision)}
                />
              ))}
            </View>
          )}

          <Button
            label="Start a mission"
            variant="primary"
            icon="rocket-outline"
            onPress={() => {
              nexus.setSendMode("mission");
              router.navigate("/");
            }}
          />

          {running.length > 0 && (
            <Card>
              <ListRow
                icon="flash-outline"
                title={`${String(running.length)} task${running.length > 1 ? "s" : ""} running`}
                detail="Live progress over the realtime channel"
                onPress={() => {
                  router.push("/tasks");
                }}
              />
            </Card>
          )}

          {controlFailure !== undefined && <FailureView failure={controlFailure} />}

          {control !== undefined && !control.configured && (
            <StateView
              icon="construct-outline"
              title="Mission engine not configured"
              message={control.detail}
            />
          )}
          {control !== undefined && control.configured && !control.reachable && (
            <StateView
              icon="cloud-offline-outline"
              title="Mission engine unreachable"
              message={control.detail}
              action={
                <Button label="Try again" icon="refresh" onPress={() => void resource.reload()} />
              }
            />
          )}

          {control !== undefined && control.reachable && (
            <>
              <SectionHeader title="Missions" />
              {control.missions.length === 0 && (
                <StateView
                  icon="rocket-outline"
                  title="No missions yet"
                  message="Start one above, or schedule one from the dashboard."
                />
              )}
              {control.missions.map((mission) => {
                const progress = missionProgress(mission.tasks);
                return (
                  <Card
                    key={mission.id}
                    onPress={() => {
                      router.push(`/mission/${mission.id}`);
                    }}
                    accessibilityLabel={`Open mission ${mission.title}`}
                  >
                    <Text
                      style={{ color: theme.color.text, fontSize: 15, fontWeight: "600" }}
                      numberOfLines={2}
                    >
                      {mission.title}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Badge status={mission.state} />
                      <Text style={{ color: theme.color.textFaint, fontSize: 12 }}>
                        {progress.done}/{progress.total} tasks ·{" "}
                        {formatRelative(mission.updated_at)}
                      </Text>
                    </View>
                    <ProgressBar percent={progress.percent} />
                  </Card>
                );
              })}

              {control.schedules.length > 0 && <SectionHeader title="Schedules" />}
              {control.schedules.map((schedule) => (
                <Card key={schedule.id}>
                  <ListRow
                    title={schedule.name}
                    detail={
                      schedule.next_run_at === null
                        ? (schedule.cron_expression ?? "No upcoming run")
                        : `Next ${formatRelative(schedule.next_run_at)}`
                    }
                    trailing={
                      schedule.state === "completed" ? (
                        <Badge status="completed" />
                      ) : (
                        <Button
                          label={schedule.state === "paused" ? "Resume" : "Pause"}
                          onPress={() => {
                            setPaused(schedule.id, schedule.state !== "paused");
                          }}
                        />
                      )
                    }
                  />
                </Card>
              ))}
            </>
          )}
        </>
      )}
    </ResourceScreen>
  );
}
