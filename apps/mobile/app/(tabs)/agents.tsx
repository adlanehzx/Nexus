import { Text, View } from "react-native";
import { router } from "expo-router";
import {
  Badge,
  Card,
  ProgressBar,
  ResourceScreen,
  SectionHeader,
  Stat,
  StatRow,
  StateView,
} from "../../components/ui.js";
import type { AgentRegistry, AgentRunRow, Overview } from "../../lib/api-types.js";
import { formatDuration, formatRelative } from "../../lib/format.js";
import { useNexus } from "../../lib/nexus.js";
import { useAutoRefresh, useResource } from "../../lib/use-resource.js";
import { useTheme } from "../../theme/index.js";

interface AgentsData {
  overview: Overview;
  registry: AgentRegistry | undefined;
  runs: AgentRunRow[];
}

/** Who can work, who is working, and what they did. */
export default function AgentsScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const resource = useResource<AgentsData>("agents", async () => {
    const [overview, registry, runs] = await Promise.all([
      nexus.mobile.overview(),
      // The agent engine is optional on an installation.
      nexus.mobile.agentRegistry().catch(() => undefined),
      nexus.mobile.listRuns(30),
    ]);
    return { overview, registry, runs };
  });
  useAutoRefresh(resource.reload, 10_000);

  return (
    <ResourceScreen resource={resource}>
      {({ overview, registry, runs }) => (
        <>
          <StatRow>
            <Stat
              label="Running"
              value={String(overview.agentRuns.running)}
              {...(overview.agentRuns.running > 0 ? { tone: "live" as const } : {})}
            />
            <Stat
              label="Awaiting you"
              value={String(overview.agentRuns.waitingForConfirmation)}
              {...(overview.agentRuns.waitingForConfirmation > 0 ? { tone: "warn" as const } : {})}
            />
            <Stat
              label="Failed"
              value={String(overview.agentRuns.failed)}
              {...(overview.agentRuns.failed > 0 ? { tone: "bad" as const } : {})}
            />
          </StatRow>

          {registry !== undefined && registry.configured.length > 0 && (
            <>
              <SectionHeader title="Agents" />
              {registry.configured.map((agent) => (
                <Card key={agent.key}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                    <Text
                      style={{ color: theme.color.text, fontSize: 15, fontWeight: "600", flex: 1 }}
                    >
                      {agent.key}
                    </Text>
                    <Badge status={agent.status} />
                  </View>
                  <Text style={{ color: theme.color.textMuted, fontSize: 12 }}>
                    {agent.running_tasks} running · {agent.queued_tasks} queued
                    {agent.last_error_category === null
                      ? ""
                      : ` · last error: ${agent.last_error_category}`}
                  </Text>
                  {agent.remaining_week_percent !== null && (
                    <>
                      <Text style={{ color: theme.color.textFaint, fontSize: 11 }}>
                        {agent.remaining_week_percent}% of weekly quota left ({agent.usage_source})
                      </Text>
                      <ProgressBar
                        percent={agent.remaining_week_percent}
                        tone={agent.remaining_week_percent < 15 ? "bad" : "ok"}
                      />
                    </>
                  )}
                </Card>
              ))}
            </>
          )}

          <SectionHeader title="Recent runs" />
          {runs.length === 0 && (
            <StateView
              icon="sparkles-outline"
              title="No runs yet"
              message="Each conversation with the agent appears here."
            />
          )}
          {runs.map((run) => (
            <Card
              key={run.runId}
              onPress={() => {
                router.push(`/run/${run.runId}`);
              }}
              accessibilityLabel={`Open run, ${run.status}`}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ color: theme.color.text, fontSize: 14, flex: 1 }} numberOfLines={2}>
                  {run.response ?? run.metrics.model}
                </Text>
                <Badge status={run.status} />
              </View>
              <Text style={{ color: theme.color.textFaint, fontSize: 12 }}>
                {run.metrics.model} · {run.metrics.toolCalls} tools ·{" "}
                {formatDuration(run.durationMs)} · {formatRelative(run.startedAt)}
              </Text>
            </Card>
          ))}
        </>
      )}
    </ResourceScreen>
  );
}
