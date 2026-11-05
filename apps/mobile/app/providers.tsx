import { useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { Badge, Button, Card, ListRow, ResourceScreen, SectionHeader } from "../components/ui.js";
import type {
  ConnectionEntry,
  LlmEngineConfig,
  LlmEnginesSection,
  ProviderAccount,
  ProviderDriver,
  ProviderModel,
} from "../lib/api-types.js";
import { describeFailure, failureMessage, type Failure } from "../lib/errors.js";
import { formatRelative, humanize } from "../lib/format.js";
import { useNexus } from "../lib/nexus.js";
import { useResource } from "../lib/use-resource.js";
import { useTheme } from "../theme/index.js";

interface ProvidersData {
  engines: LlmEnginesSection | undefined;
  enginesFailure: Failure | undefined;
  accounts: ProviderAccount[];
  connections: ConnectionEntry[];
  drivers: ProviderDriver[];
  models: ProviderModel[];
}

/**
 * Which brains NEXUS may use.
 *
 * Routing is a server-wide setting, not per message: the agent API takes no
 * model parameter. So the choice lives here, with the order it is tried in,
 * and the chat reports the model that actually answered.
 */
export default function ProvidersScreen() {
  const theme = useTheme();
  const nexus = useNexus();
  const [busy, setBusy] = useState(false);

  const resource = useResource<ProvidersData>("providers", async () => {
    const [engines, accounts, connections, drivers, models] = await Promise.allSettled([
      nexus.mobile.llmEngines(),
      nexus.mobile.providerAccounts(),
      nexus.mobile.connections(),
      nexus.mobile.providers(),
      nexus.mobile.models(),
    ]);
    const list = <T,>(result: PromiseSettledResult<T[]>): T[] =>
      result.status === "fulfilled" ? result.value : [];
    return {
      engines: engines.status === "fulfilled" ? engines.value : undefined,
      enginesFailure: engines.status === "rejected" ? describeFailure(engines.reason) : undefined,
      accounts: list(accounts),
      connections: list(connections),
      drivers: list(drivers),
      models: list(models),
    };
  });

  const saveRouting = async (section: LlmEnginesSection, engines: LlmEngineConfig[]) => {
    setBusy(true);
    try {
      await nexus.mobile.saveLlmRouting({ ...section, engines });
      await resource.reload();
    } catch (cause) {
      Alert.alert("Routing not saved", failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const moveEngine = (
    section: LlmEnginesSection,
    ordered: LlmEngineConfig[],
    index: number,
    delta: number,
  ) => {
    const next = [...ordered];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + delta, 0, moved);
    void saveRouting(
      section,
      next.map((engine, position) => ({ ...engine, priority: position + 1 })),
    );
  };

  return (
    <ResourceScreen resource={resource}>
      {({ engines, enginesFailure, accounts, connections, drivers, models }) => {
        const ordered =
          engines === undefined ? [] : [...engines.engines].sort((a, b) => a.priority - b.priority);
        return (
          <>
            <SectionHeader title="Routing" />
            {enginesFailure !== undefined && (
              <Card>
                <Text style={{ color: theme.color.textMuted, fontSize: 13 }}>
                  {enginesFailure.title}. {enginesFailure.message}
                </Text>
              </Card>
            )}
            {engines !== undefined && (
              <Card>
                <ListRow
                  title="Prefer local models"
                  detail="Use device-hosted engines first when one is eligible."
                  trailing={
                    <Switch
                      value={engines.preferLocal}
                      disabled={busy}
                      accessibilityLabel="Prefer local models"
                      onValueChange={(preferLocal) => {
                        void saveRouting({ ...engines, preferLocal }, engines.engines);
                      }}
                    />
                  }
                />
                {ordered.length === 0 && (
                  <Text style={{ color: theme.color.textMuted, fontSize: 13 }}>
                    No engine configured. Credentials are added from the dashboard.
                  </Text>
                )}
                {ordered.map((engine, index) => {
                  const status = engines.status?.engines.find((entry) => entry.id === engine.id);
                  return (
                    <View key={engine.id} style={{ gap: 6, paddingVertical: 6 }}>
                      <ListRow
                        title={`${String(index + 1)}. ${engine.label}`}
                        detail={`${engine.model}${status?.credentialConfigured === false ? " · no credential" : ""}`}
                        trailing={
                          <Switch
                            value={engine.enabled}
                            disabled={busy}
                            accessibilityLabel={`Enable ${engine.label}`}
                            onValueChange={(enabled) => {
                              void saveRouting(
                                engines,
                                engines.engines.map((candidate) =>
                                  candidate.id === engine.id
                                    ? { ...candidate, enabled }
                                    : candidate,
                                ),
                              );
                            }}
                          />
                        }
                      />
                      {ordered.length > 1 && (
                        <View style={{ flexDirection: "row", gap: 6 }}>
                          <Button
                            label="Earlier"
                            icon="arrow-up"
                            disabled={busy || index === 0}
                            onPress={() => {
                              moveEngine(engines, ordered, index, -1);
                            }}
                          />
                          <Button
                            label="Later"
                            icon="arrow-down"
                            disabled={busy || index === ordered.length - 1}
                            onPress={() => {
                              moveEngine(engines, ordered, index, 1);
                            }}
                          />
                        </View>
                      )}
                    </View>
                  );
                })}
              </Card>
            )}

            {accounts.length > 0 && <SectionHeader title="Accounts" />}
            {accounts.map((account) => (
              <Card key={account.id} style={{ paddingVertical: 8 }}>
                <ListRow
                  title={account.name}
                  detail={`${account.provider} · reliability ${String(Math.round(account.reliability.score * 100))}% · checked ${formatRelative(account.lastCheckedAt)}`}
                  trailing={<Badge status={account.authStatus} />}
                />
              </Card>
            ))}

            {connections.length > 0 && <SectionHeader title="Connections" />}
            {connections.map((connection) => (
              <ConnectionCard
                key={connection.providerId}
                connection={connection}
                onTested={resource.reload}
              />
            ))}

            {drivers.length > 0 && <SectionHeader title="Catalogue" />}
            {drivers.map((driver) => {
              const count = models.filter((model) => model.provider === driver.id).length;
              const abilities = Object.entries(driver.capabilities)
                .filter(([, supported]) => supported)
                .map(([name]) => humanize(name).toLowerCase());
              return (
                <Card key={driver.id} style={{ paddingVertical: 8 }}>
                  <ListRow
                    title={driver.displayName}
                    detail={`${String(count)} models${abilities.length === 0 ? "" : ` · ${abilities.join(", ")}`}`}
                  />
                </Card>
              );
            })}
          </>
        );
      }}
    </ResourceScreen>
  );
}

function ConnectionCard({
  connection,
  onTested,
}: {
  connection: ConnectionEntry;
  onTested: () => Promise<void>;
}) {
  const theme = useTheme();
  const nexus = useNexus();
  const [busy, setBusy] = useState(false);
  const observation = connection.observation;
  return (
    <Card>
      <ListRow
        title={connection.displayName}
        detail={
          connection.supportedOnThisHost
            ? (observation?.version ?? connection.kind.toUpperCase())
            : "Not supported on the core's host"
        }
        trailing={<Badge status={observation?.state ?? "unknown"} />}
      />
      {observation?.userMessage !== null && observation?.userMessage !== undefined && (
        <Text style={{ color: theme.color.textMuted, fontSize: 12, lineHeight: 17 }}>
          {observation.userMessage}
        </Text>
      )}
      {observation?.requiresHumanAction === true && (
        <Text style={{ color: theme.color.warning, fontSize: 12, lineHeight: 17 }}>
          {observation.authGuide?.instructions ??
            "Finish signing in on the machine running the core."}
        </Text>
      )}
      {connection.supportedOnThisHost && (
        <Button
          label="Test"
          busy={busy}
          onPress={() => {
            setBusy(true);
            nexus.mobile
              .testConnection(connection.providerId)
              .then(onTested)
              .catch((cause: unknown) => {
                Alert.alert("Test failed", failureMessage(cause));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        />
      )}
    </Card>
  );
}
