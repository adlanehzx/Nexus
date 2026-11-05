import { useState } from "react";
import type { DashboardApi, McpConfiguration } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 7. MCP
// ─────────────────────────────────────────────────────────────────────────────

/** External clients acting for the signed-in user: tokens, tools and call history. */
function McpExternalAccess({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const tokens = useSection(() => api.mcpTokens());
  const tools = useSection(() => api.mcpExposedTools());
  const activity = useSection(() => api.mcpActivity());
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = "/api/v1/mcp";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="settings-panel">
        <h3>{tr("External connections to NEXUS", "Connexions externes à NEXUS")}</h3>
        <p className="muted">
          {tr(
            "An MCP client using a token acts as you, limited to the chosen scopes. Endpoint:",
            "Un client MCP muni d’un token agit en votre nom, limité aux scopes choisis. Endpoint :",
          )}{" "}
          <code>{endpoint}</code>
        </p>
        {error === null ? null : (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {created === null ? null : (
          <div className="banner" role="status">
            <strong>
              {tr(
                "Copy this token now: it will not be shown again.",
                "Copiez ce token maintenant : il ne sera plus affiché.",
              )}
            </strong>
            <div>
              <code data-testid="mcp-created-token">{created}</code>
            </div>
          </div>
        )}
        <form
          className="usage-filters"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await api.createMcpToken({ name, scopes, expiresInDays: days });
              setCreated(result.token);
              setName("");
              setScopes([]);
              tokens.reload();
            });
          }}
        >
          <label>
            {tr("Client name", "Nom du client")}{" "}
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {tr("Expires in (days)", "Expire dans (jours)")}{" "}
            <input
              type="number"
              min={1}
              max={365}
              required
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
          {(tokens.data?.availableScopes ?? []).map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) =>
                  setScopes(
                    e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                  )
                }
              />{" "}
              {scope}
            </label>
          ))}
          <button
            className="button primary"
            type="submit"
            disabled={busy || scopes.length === 0 || name.trim().length === 0}
          >
            {tr("Create token", "Créer le token")}
          </button>
        </form>
        <Section state={tokens}>
          {(data) =>
            data.tokens.length === 0 ? (
              <Empty>{tr("No external connection.", "Aucune connexion externe.")}</Empty>
            ) : (
              <Table
                head={[
                  tr("Client", "Client"),
                  tr("Scopes", "Scopes"),
                  tr("Expires", "Expire"),
                  tr("Last used", "Dernière utilisation"),
                  tr("State", "État"),
                  "",
                ]}
              >
                {data.tokens.map((token) => (
                  <tr key={token.id} data-mcp-token={token.name}>
                    <td>{token.name}</td>
                    <td className="mono">{token.scopes.join(", ")}</td>
                    <td>{new Date(token.expiresAt).toLocaleDateString()}</td>
                    <td>
                      {token.lastUsedAt === null
                        ? tr("Never", "Jamais")
                        : new Date(token.lastUsedAt).toLocaleString()}
                    </td>
                    <td>
                      {token.revokedAt === null ? tr("Active", "Actif") : tr("Revoked", "Révoqué")}
                    </td>
                    <td>
                      {token.revokedAt === null ? (
                        <button
                          className="button compact danger"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.revokeMcpToken(token.id);
                              tokens.reload();
                            })
                          }
                        >
                          {tr("Revoke", "Révoquer")}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </Table>
            )
          }
        </Section>
      </section>
      <section className="settings-panel">
        <h3>{tr("Tools exposed by NEXUS", "Outils exposés par NEXUS")}</h3>
        <Section state={tools}>
          {(data) => (
            <Table
              head={[tr("Tool", "Outil"), tr("Scope", "Scope"), tr("Description", "Description")]}
            >
              {data.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono">{tool.name}</td>
                  <td className="mono">{tool.requiredScope}</td>
                  <td>{tool.description}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </section>
      <section className="settings-panel">
        <h3>{tr("Activity", "Activité")}</h3>
        <button className="button compact" type="button" onClick={activity.reload}>
          {tr("Refresh", "Actualiser")}
        </button>
        <Section state={activity}>
          {(data) =>
            data.activity.length === 0 ? (
              <Empty>{tr("No call yet.", "Aucun appel pour l’instant.")}</Empty>
            ) : (
              <Table
                head={[
                  tr("Date", "Date"),
                  tr("Tool", "Outil"),
                  tr("Outcome", "Résultat"),
                  tr("Error", "Erreur"),
                  tr("Duration", "Durée"),
                ]}
              >
                {data.activity.map((entry) => (
                  <tr key={entry.id} data-mcp-activity={entry.tool}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td className="mono">{entry.tool}</td>
                    <td>{entry.outcome}</td>
                    <td className="mono">{entry.errorCode ?? "—"}</td>
                    <td>{entry.durationMs} ms</td>
                  </tr>
                ))}
              </Table>
            )
          }
        </Section>
      </section>
    </>
  );
}

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
      <McpExternalAccess api={api} />
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
