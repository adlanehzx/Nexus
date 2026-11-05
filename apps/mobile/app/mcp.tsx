import { useMemo, useState } from "react";
import { Alert, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  ListRow,
  ResourceScreen,
  SectionHeader,
  StateView,
} from "../components/ui.js";
import type { McpConfiguration, McpSection, ToolRow } from "../lib/api-types.js";
import { useAppLock } from "../lib/app-lock.js";
import { failureMessage } from "../lib/errors.js";
import { useNexus } from "../lib/nexus.js";
import { useResource } from "../lib/use-resource.js";
import { type Theme, useTheme, useThemedStyles } from "../theme/index.js";

interface McpData {
  section: McpSection;
  tools: ToolRow[];
}

/**
 * MCP Hub.
 *
 * Inspect health, reconnect, enable or disable, and add a remote server. Local
 * (stdio) servers and per-tool policies are displayed but edited on the
 * dashboard: typing a command line and its environment on a phone is how a
 * server gets misconfigured.
 */
export default function McpScreen() {
  const nexus = useNexus();
  const theme = useTheme();
  const lock = useAppLock();
  const [busy, setBusy] = useState(false);
  const resource = useResource<McpData>("mcp", async () => {
    const [section, tools] = await Promise.all([nexus.mobile.mcp(), nexus.mobile.tools()]);
    return { section, tools };
  });

  const run = async (work: () => Promise<unknown>) => {
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
      {({ section, tools }) => (
        <>
          {!section.configured && (
            <StateView
              icon="construct-outline"
              title="MCP is not active"
              message="The MCP runtime is not available on this core. Saved servers apply once it is."
            />
          )}

          <SectionHeader title="Servers" />
          {section.configurations.length === 0 && (
            <StateView
              icon="extension-puzzle-outline"
              title="No servers"
              message="Add a remote server below or configure one from the dashboard."
            />
          )}
          {section.configurations.map((config) => (
            <ServerCard
              key={config.name}
              config={config}
              status={section.servers.find((server) => server.name === config.name)}
              busy={busy}
              onToggle={(enabled) => {
                void (async () => {
                  if (!(await lock.confirmRemoteAction(`Change MCP server ${config.name}`))) return;
                  await run(() => nexus.mobile.saveMcp({ ...config, enabled }));
                })();
              }}
              onReconnect={() => {
                void run(() => nexus.mobile.reconnectMcp(config.name));
              }}
              onRemove={() => {
                Alert.alert(`Remove ${config.name}?`, "Its tools stop being available to NEXUS.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => {
                      void (async () => {
                        if (!(await lock.confirmRemoteAction(`Remove MCP server ${config.name}`)))
                          return;
                        await run(() => nexus.mobile.removeMcp(config.name));
                      })();
                    },
                  },
                ]);
              }}
            />
          ))}

          <AddServer
            existing={section.configurations.map((config) => config.name)}
            busy={busy}
            onAdd={async (name, url) => {
              if (!(await lock.confirmRemoteAction(`Add MCP server ${name}`))) return false;
              let added = false;
              await run(async () => {
                await nexus.mobile.saveMcp({
                  name,
                  url,
                  transport: "http",
                  enabled: true,
                  defaultPermissions: [],
                  defaultRisk: "MEDIUM",
                  toolPolicies: {},
                  headers: {},
                  headerRefs: {},
                });
                added = true;
              });
              return added;
            }}
          />

          <SectionHeader title={`Tools · ${String(tools.length)}`} />
          <ToolList tools={tools} />
          <Text style={{ color: theme.color.textFaint, fontSize: 12 }}>
            Tool permissions are enforced by the core. Change them from the dashboard.
          </Text>
        </>
      )}
    </ResourceScreen>
  );
}

function ServerCard({
  config,
  status,
  busy,
  onToggle,
  onReconnect,
  onRemove,
}: {
  config: McpConfiguration;
  status: McpSection["servers"][number] | undefined;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card>
      <View style={styles.spread}>
        <Text style={styles.title} numberOfLines={1}>
          {config.name}
        </Text>
        <Switch
          value={config.enabled}
          disabled={busy}
          onValueChange={onToggle}
          accessibilityLabel={`Enable ${config.name}`}
        />
      </View>
      <View style={styles.badges}>
        <Badge status={status?.status ?? (config.enabled ? "unknown" : "disabled")} />
        <Badge label={config.transport} tone="muted" />
        <Badge label={`risk ${config.defaultRisk.toLowerCase()}`} tone="muted" />
      </View>
      <Text style={styles.muted} numberOfLines={2}>
        {config.url ?? config.command ?? ""}
      </Text>
      {status !== undefined && (
        <Text style={styles.muted}>
          {status.toolCount} tools
          {status.serverInfo === null
            ? ""
            : ` · ${status.serverInfo.name} ${status.serverInfo.version}`}
        </Text>
      )}
      {status?.lastError !== null && status?.lastError !== undefined && (
        <Text style={styles.error} numberOfLines={3}>
          {status.lastError}
        </Text>
      )}
      <View style={styles.badges}>
        <Button
          label="Reconnect"
          icon="refresh"
          disabled={busy || !config.enabled}
          onPress={onReconnect}
        />
        <Button label="Remove" variant="danger" disabled={busy} onPress={onRemove} />
      </View>
    </Card>
  );
}

function AddServer({
  existing,
  busy,
  onAdd,
}: {
  existing: string[];
  busy: boolean;
  onAdd: (name: string, url: string) => Promise<boolean>;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  if (!open) {
    return (
      <Button
        label="Add a remote server"
        icon="add"
        onPress={() => {
          setOpen(true);
        }}
      />
    );
  }

  const trimmedName = name.trim();
  const problem = existing.includes(trimmedName)
    ? "A server with this name already exists."
    : trimmedName.length > 40
      ? "Names are limited to 40 characters."
      : undefined;
  const valid =
    trimmedName.length > 0 && /^https:\/\/\S+$/.test(url.trim()) && problem === undefined;

  return (
    <Card>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Server name"
      />
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="https://mcp.example.com/mcp"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Server URL"
      />
      {problem !== undefined && <Text style={styles.error}>{problem}</Text>}
      <Text style={styles.muted}>
        Servers needing credentials are configured from the dashboard, where secrets are stored by
        reference.
      </Text>
      <View style={styles.badges}>
        <Button
          label="Cancel"
          onPress={() => {
            setOpen(false);
          }}
        />
        <Button
          label="Add"
          variant="primary"
          disabled={!valid}
          busy={busy}
          onPress={() => {
            void onAdd(trimmedName, url.trim()).then((added) => {
              if (added) {
                setOpen(false);
                setName("");
                setUrl("");
              }
            });
          }}
        />
      </View>
    </Card>
  );
}

function ToolList({ tools }: { tools: ToolRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => [...tools].sort((a, b) => a.name.localeCompare(b.name)), [tools]);
  const visible = expanded ? sorted : sorted.slice(0, 12);
  return (
    <Card>
      {visible.map((tool) => (
        <ListRow
          key={tool.name}
          title={tool.name}
          detail={`${tool.source} · risk ${tool.riskLevel.toLowerCase()}${
            tool.requiredPermissions.length === 0
              ? ""
              : ` · needs ${tool.requiredPermissions.join(", ")}`
          }`}
          trailing={
            <Badge
              label={tool.allowed ? "allowed" : "denied"}
              tone={tool.allowed ? "ok" : "muted"}
            />
          }
        />
      ))}
      {sorted.length > visible.length && (
        <Button
          label={`Show all ${String(sorted.length)}`}
          onPress={() => {
            setExpanded(true);
          }}
        />
      )}
    </Card>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    spread: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    title: { color: theme.color.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
    muted: { color: theme.color.textMuted, fontSize: 12, lineHeight: 17 },
    error: { color: theme.color.danger, fontSize: 12, lineHeight: 17 },
    badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    input: {
      backgroundColor: theme.color.backgroundSunken,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      color: theme.color.text,
      fontSize: 15,
      minHeight: 44,
      paddingHorizontal: theme.space(5),
    },
  });
