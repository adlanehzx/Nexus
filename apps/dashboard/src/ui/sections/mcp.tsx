import { useState } from "react";
import type { DashboardApi, McpConfiguration } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 7. MCP
// ─────────────────────────────────────────────────────────────────────────────

export function Mcp({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.mcp());
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [secretRefs, setSecretRefs] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (operation: () => Promise<unknown>, success: string): void => {
    setActionError(null);
    setMessage(null);
    void operation()
      .then(() => {
        setMessage(success);
        state.reload();
      })
      .catch((cause: unknown) =>
        setActionError(
          cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  const save = (): void => {
    let refs: Record<string, string>;
    try {
      refs = secretRefs.trim() === "" ? {} : (JSON.parse(secretRefs) as Record<string, string>);
    } catch {
      setActionError(
        tr(
          "Secret references must be a JSON object.",
          "Les références de secrets doivent être un objet JSON.",
        ),
      );
      return;
    }
    const common = {
      name,
      enabled: true,
      defaultPermissions: [],
      defaultRisk: "MEDIUM" as const,
      toolPolicies: {},
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 60_000,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectInitialDelayMs: 500,
      reconnectMaxDelayMs: 30_000,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60_000,
      exposeResources: true,
    };
    const config: McpConfiguration =
      transport === "stdio"
        ? {
            ...common,
            transport,
            command: target,
            args: args
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
            env: {},
            envRefs: refs,
          }
        : { ...common, transport, url: target, headers: {}, headerRefs: refs };
    act(
      () => api.saveMcp(config),
      tr(`Server ${name} saved and connected.`, `Serveur ${name} enregistré et connecté.`),
    );
  };

  return (
    <div className="content">
      {message === null ? null : <p className="banner success">{message}</p>}
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="settings-panel">
        <h3>{tr("Add or Replace an MCP Server", "Ajouter ou remplacer un serveur MCP")}</h3>
        <div className="settings-grid">
          <label>
            {tr("Name", "Nom")}
            <input
              className="field mono"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="filesystem"
            />
          </label>
          <label>
            {tr("Transport", "Transport")}
            <select
              className="field"
              value={transport}
              onChange={(event) => setTransport(event.target.value as "stdio" | "http" | "sse")}
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </label>
          <label className="settings-wide">
            {transport === "stdio" ? tr("Command", "Commande") : "URL"}
            <input
              className="field mono"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={transport === "stdio" ? "npx" : "https://…"}
            />
          </label>
          {transport === "stdio" ? (
            <label className="settings-wide">
              {tr("Arguments · one per line", "Arguments · un par ligne")}
              <textarea
                className="field mono"
                rows={3}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          ) : null}
          <label className="settings-wide">
            {transport === "stdio" ? "envRefs" : "headerRefs"} ·{" "}
            {tr("JSON to vault://nexus/…", "JSON vers vault://nexus/…")}
            <textarea
              className="field mono"
              rows={3}
              value={secretRefs}
              onChange={(event) => setSecretRefs(event.target.value)}
              placeholder={'{"TOKEN":"vault://nexus/mcp-token"}'}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="button primary"
            type="button"
            disabled={name === "" || target === ""}
            onClick={save}
          >
            {tr("Save and connect", "Enregistrer et connecter")}
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) =>
          data.configurations.length === 0 ? (
            <Empty>{tr("No MCP servers configured.", "Aucun serveur MCP configuré.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Server", "Serveur"),
                tr("State", "État"),
                tr("Tools", "Outils"),
                tr("Failures", "Échecs"),
                tr("Reconnects", "Reconnexions"),
                tr("Circuit", "Disjoncteur"),
                tr("Last error", "Dernière erreur"),
                tr("Actions", "Actions"),
              ]}
            >
              {data.servers.map((server) => (
                <tr key={server.name}>
                  <td>
                    {server.name}
                    {server.serverInfo === null ? null : (
                      <div className="muted mono">
                        {server.serverInfo.name} {server.serverInfo.version}
                      </div>
                    )}
                  </td>
                  <td>
                    <State
                      tone={server.status === "connected" ? "ok" : "down"}
                      label={server.status}
                    />
                  </td>
                  <td>{server.toolCount}</td>
                  <td>{server.consecutiveFailures}</td>
                  <td>{server.reconnectAttempts}</td>
                  <td className="muted">
                    {server.circuitOpenUntil === null
                      ? tr("closed", "fermé")
                      : `${tr("open until", "ouvert jusqu'à")} ${server.circuitOpenUntil}`}
                  </td>
                  <td className="muted">{server.lastError ?? "—"}</td>
                  <td>
                    <button
                      className="button compact"
                      type="button"
                      onClick={() =>
                        act(
                          () => api.reconnectMcp(server.name),
                          tr(`${server.name} reconnected.`, `${server.name} reconnecté.`),
                        )
                      }
                    >
                      {tr("Reconnect", "Reconnecter")}
                    </button>{" "}
                    <button
                      className="button compact danger"
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            tr(
                              `Delete server ${server.name}?`,
                              `Supprimer le serveur ${server.name} ?`,
                            ),
                          )
                        )
                          act(
                            () => api.removeMcp(server.name),
                            tr(`${server.name} deleted.`, `${server.name} supprimé.`),
                          );
                      }}
                    >
                      {tr("Delete", "Supprimer")}
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}
