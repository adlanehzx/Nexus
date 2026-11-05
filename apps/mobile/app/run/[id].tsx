import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  Badge,
  Button,
  Card,
  ResourceScreen,
  SectionHeader,
  Stat,
  StatRow,
} from "../../components/ui.js";
import { failureMessage } from "../../lib/errors.js";
import { formatDuration, formatRelative } from "../../lib/format.js";
import { useNexus } from "../../lib/nexus.js";
import { useAutoRefresh, useResource } from "../../lib/use-resource.js";
import { formatTokens } from "../../lib/usage.js";
import { useTheme } from "../../theme/index.js";

const ACTIVE = new Set(["running", "waiting_for_confirmation"]);

/** One agent session: what it did, and the controls that apply to its current state. */
export default function RunScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [busy, setBusy] = useState(false);
  const resource = useResource(`run:${id}`, () => nexus.mobile.getRunDetail(id));
  useAutoRefresh(resource.reload, 5_000);

  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .then(resource.reload)
      .catch((cause: unknown) => {
        Alert.alert("Action failed", failureMessage(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const text = { color: theme.color.text, fontSize: 14, lineHeight: 20 } as const;
  const muted = { color: theme.color.textMuted, fontSize: 12 } as const;

  return (
    <ResourceScreen resource={resource}>
      {(run) => {
        const status = run.status.toLowerCase();
        return (
          <>
            <Card>
              <Badge status={run.status} />
              <Text style={muted}>
                {run.metrics.model} · started {formatRelative(run.startedAt)} ·{" "}
                {formatDuration(run.durationMs)}
                {run.replayOfRunId === null ? "" : " · replay"}
              </Text>
              {run.stopReason !== null && <Text style={muted}>Stopped: {run.stopReason}</Text>}
            </Card>

            <StatRow>
              <Stat label="Input" value={formatTokens(run.metrics.inputTokens)} />
              <Stat label="Output" value={formatTokens(run.metrics.outputTokens)} />
              <Stat label="Tools" value={String(run.metrics.toolCalls)} />
            </StatRow>

            {status === "waiting_for_confirmation" && (
              <Card>
                <Text style={{ ...text, fontWeight: "600" }}>
                  This run is waiting for your decision.
                </Text>
                {run.tools
                  .filter((tool) => tool.status.toLowerCase() !== "succeeded")
                  .slice(-1)
                  .map((tool) => (
                    <Text key={tool.callId} style={muted}>
                      {tool.tool} · risk {tool.riskLevel}
                    </Text>
                  ))}
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Reject"
                      variant="danger"
                      disabled={busy}
                      onPress={() => {
                        act(() => nexus.mobile.answerRunConfirmation(id, "rejected"));
                      }}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label="Approve"
                      variant="primary"
                      busy={busy}
                      onPress={() => {
                        act(() => nexus.mobile.answerRunConfirmation(id, "approved"));
                      }}
                    />
                  </View>
                </View>
              </Card>
            )}

            {ACTIVE.has(status) && (
              <Button
                label="Interrupt this run"
                variant="danger"
                icon="stop-circle-outline"
                disabled={busy}
                onPress={() => {
                  Alert.alert("Interrupt this run?", "Work in progress stops immediately.", [
                    { text: "Keep running", style: "cancel" },
                    {
                      text: "Interrupt",
                      style: "destructive",
                      onPress: () => {
                        act(async () => {
                          const cancelled = await nexus.mobile.cancelRun(id);
                          if (!cancelled) throw new Error("The run has already finished.");
                        });
                      },
                    },
                  ]);
                }}
              />
            )}

            {!ACTIVE.has(status) && (
              <Button
                label="Run again"
                icon="refresh"
                busy={busy}
                onPress={() => {
                  Alert.alert(
                    "Run this again?",
                    "The same request is executed once more, including any real-world action. Risky tools still ask for confirmation.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Run again",
                        onPress: () => {
                          setBusy(true);
                          nexus.mobile
                            .replayRun(id)
                            .then((replay) => {
                              router.replace(`/run/${replay.runId}`);
                            })
                            .catch((cause: unknown) => {
                              Alert.alert("Could not run again", failureMessage(cause));
                            })
                            .finally(() => {
                              setBusy(false);
                            });
                        },
                      },
                    ],
                  );
                }}
              />
            )}

            {run.response !== null && (
              <Card>
                <SectionHeader title="Answer" />
                <Text style={text} selectable>
                  {run.response}
                </Text>
              </Card>
            )}

            {run.tools.length > 0 && <SectionHeader title="Tools used" />}
            {run.tools.map((tool) => (
              <Card key={tool.callId}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ ...text, flex: 1 }} numberOfLines={1}>
                    {tool.tool}
                  </Text>
                  <Badge status={tool.status} />
                </View>
                <Text style={muted}>
                  Risk {tool.riskLevel} · {formatDuration(tool.durationMs)}
                  {tool.errorCode === null ? "" : ` · ${tool.errorCode}`}
                </Text>
              </Card>
            ))}

            {run.errors.length > 0 && <SectionHeader title="Errors" />}
            {run.errors.map((error) => (
              <Card key={`${error.at}${error.code}`}>
                <Text style={{ ...text, color: theme.color.danger }}>{error.message}</Text>
                <Text style={muted}>
                  {error.code} · {formatRelative(error.at)}
                </Text>
              </Card>
            ))}
          </>
        );
      }}
    </ResourceScreen>
  );
}
