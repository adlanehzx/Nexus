import { useState } from "react";
import type {
  CheckpointDto,
  DashboardApi,
  SourceControlLinkDto,
  ThreadTurnDiffDto,
  WorktreeDto,
  WorktreeStatusDto,
} from "../../lib/api.js";
import { formatAge } from "../../lib/format.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import { IconCheck, IconWarning, IconArrowRight, IconEye } from "../icons.js";

type VcsTab = "worktrees" | "checkpoints" | "source-control";

export function VcsWorktrees({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [activeTab, setActiveTab] = useState<VcsTab>("worktrees");

  // Worktrees state
  const worktreesState = useSection(() => api.worktrees("."));
  const [newBranch, setNewBranch] = useState("");
  const [newStrategy, setNewStrategy] = useState<"isolated" | "branch" | "share">("isolated");
  const [inspectedStatus, setInspectedStatus] = useState<{
    path: string;
    status: WorktreeStatusDto;
  } | null>(null);

  // Checkpoints state
  const [threadId, setThreadId] = useState("default");
  const checkpointsState = useSection(() => api.checkpoints(threadId), [threadId]);
  const [activeDiff, setActiveDiff] = useState<ThreadTurnDiffDto | null>(null);

  // Source Control state
  const scLinksState = useSection(() => api.sourceControlLinks());
  const [prUrl, setPrUrl] = useState("");
  const [prBranch, setPrBranch] = useState("");
  const [prNumber, setPrNumber] = useState("");

  // Feedback notifications
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const notifySuccess = (msg: string) => {
    setBannerError(null);
    setBannerMessage(msg);
  };

  const notifyError = (err: unknown) => {
    setBannerMessage(null);
    setBannerError(err instanceof Error ? err.message : String(err));
  };

  // Worktree actions
  const handleCreateWorktree = async () => {
    if (!newBranch.trim()) return;
    try {
      await api.createWorktree({
        workspaceRoot: ".",
        branchName: newBranch.trim(),
        strategy: newStrategy,
      });
      notifySuccess(
        tr(
          `Worktree created for branch ${newBranch}.`,
          `Worktree créé pour la branche ${newBranch}.`,
        ),
      );
      setNewBranch("");
      worktreesState.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  const handleInspectWorktree = async (wt: WorktreeDto) => {
    try {
      const status = await api.worktreeStatus(wt.path);
      setInspectedStatus({ path: wt.path, status });
    } catch (e) {
      notifyError(e);
    }
  };

  const handleHandoff = async (wt: WorktreeDto) => {
    const targetBranch = globalThis.prompt(
      tr("Target branch to handoff into:", "Branche cible pour le handoff :"),
      "master",
    );
    if (!targetBranch) return;
    const commitMsg = globalThis.prompt(
      tr("Handoff commit message:", "Message de commit pour le handoff :"),
      `feat(handoff): merge worktree ${wt.branch}`,
    );
    if (!commitMsg) return;

    try {
      const res = await api.handoffWorktree({
        worktreePath: wt.path,
        targetBranch,
        commitMessage: commitMsg,
      });
      if (res.success) {
        notifySuccess(
          tr(
            `Handoff succeeded (commit: ${res.commitSha?.slice(0, 7) ?? "done"}).`,
            `Handoff réussi (commit: ${res.commitSha?.slice(0, 7) ?? "terminé"}).`,
          ),
        );
        worktreesState.reload();
      }
    } catch (e) {
      notifyError(e);
    }
  };

  const handleRemoveWorktree = async (wt: WorktreeDto) => {
    if (
      !globalThis.confirm(
        tr(`Delete worktree at ${wt.path}?`, `Supprimer le worktree à ${wt.path} ?`),
      )
    )
      return;
    try {
      await api.removeWorktree({
        workspaceRoot: ".",
        worktreePath: wt.path,
        force: true,
      });
      notifySuccess(tr("Worktree pruned.", "Worktree supprimé."));
      if (inspectedStatus?.path === wt.path) setInspectedStatus(null);
      worktreesState.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  // Checkpoints actions
  const handleRestoreTurn = async (turn: number) => {
    if (
      !globalThis.confirm(
        tr(
          `Rollback workspace to Turn #${turn}? Any unsaved changes in current turn will be safely backed up and wiped.`,
          `Revenir au Tour #${turn} ? Toutes les modifications non sauvegardées du tour actuel seront archivées de secours puis réinitialisées.`,
        ),
      )
    )
      return;

    try {
      const res = await api.restoreCheckpoint(threadId, { turnCount: turn, cwd: "." });
      if (res.success) {
        notifySuccess(
          tr(
            `Restored workspace to Turn #${res.restoredTurnCount}.`,
            `Espace de travail restauré au Tour #${res.restoredTurnCount}.`,
          ),
        );
        checkpointsState.reload();
      } else {
        notifyError(
          tr("Rollback returned no changes.", "Le rollback n'a produit aucun changement."),
        );
      }
    } catch (e) {
      notifyError(e);
    }
  };

  const handleInspectDiff = async (turn: number) => {
    try {
      const res = await api.checkpointDiff(threadId, Math.max(0, turn - 1), turn, ".");
      setActiveDiff(res.diff);
    } catch (e) {
      notifyError(e);
    }
  };

  // Source Control actions
  const handleLinkPr = async () => {
    if (!prUrl.trim() || !prBranch.trim()) return;
    try {
      await api.linkPullRequest({
        provider: prUrl.includes("gitlab") ? "gitlab" : "github",
        repoUrl: prUrl.trim(),
        branch: prBranch.trim(),
        ...(prNumber.trim() ? { pullRequestNumber: parseInt(prNumber.trim(), 10) } : {}),
        threadId,
      });
      notifySuccess(tr("Pull request linked successfully.", "Pull request liée avec succès."));
      setPrUrl("");
      setPrBranch("");
      setPrNumber("");
      scLinksState.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  const handleToggleWatch = async (link: SourceControlLinkDto) => {
    try {
      await api.setPullRequestWatched(link.id, !link.watched);
      scLinksState.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  const handleUnlink = async (link: SourceControlLinkDto) => {
    if (!globalThis.confirm(tr("Unlink this PR?", "Détacher cette PR ?"))) return;
    try {
      await api.unlinkPullRequest(link.id);
      scLinksState.reload();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <div className="content">
      {bannerMessage && <p className="banner success">{bannerMessage}</p>}
      {bannerError && <p className="banner error">{bannerError}</p>}

      {/* Top tabs */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <button
          type="button"
          className={`button ${activeTab === "worktrees" ? "primary" : "secondary"}`}
          onClick={() => setActiveTab("worktrees")}
        >
          {tr("Git Worktrees", "Worktrees Git")}
        </button>
        <button
          type="button"
          className={`button ${activeTab === "checkpoints" ? "primary" : "secondary"}`}
          onClick={() => setActiveTab("checkpoints")}
        >
          {tr("Checkpoints & Rollbacks", "Checkpoints & Rollbacks")}
        </button>
        <button
          type="button"
          className={`button ${activeTab === "source-control" ? "primary" : "secondary"}`}
          onClick={() => setActiveTab("source-control")}
        >
          {tr("Source Control & PRs", "Contrôle de Source & PRs")}
        </button>
      </div>

      {/* TAB 1: WORKTREES */}
      {activeTab === "worktrees" && (
        <Section state={worktreesState}>
          {({ worktrees }) => (
            <>
              <div className="metrics" style={{ marginBottom: "1.5rem" }}>
                <Metric
                  value={String(worktrees.length)}
                  label={tr("active worktrees", "worktrees actifs")}
                />
                <Metric
                  value={String(worktrees.filter((w) => w.status === "active").length)}
                  label={tr("clean trees", "arbres sains")}
                  tone="positive"
                />
                <Metric
                  value={String(worktrees.filter((w) => w.status === "dirty").length)}
                  label={tr("dirty trees", "arbres modifiés")}
                  alert={worktrees.some((w) => w.status === "dirty")}
                />
              </div>

              {/* Create Worktree Panel */}
              <section className="settings-panel" style={{ marginBottom: "1.5rem" }}>
                <h3>
                  {tr("Spawn an Isolated Mission Worktree", "Créer un Worktree de Mission Isolé")}
                </h3>
                <p className="muted">
                  {tr(
                    "Allows background agents to perform heavy refactors or experiment on isolated branches without touching the main checkout.",
                    "Permet aux agents d'exécuter des refactorisations lourdes ou d'expérimenter sur des branches isolées sans impacter le checkout principal.",
                  )}
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    type="text"
                    placeholder={tr(
                      "New branch name (e.g. feat/isolated-worker)",
                      "Nom de branche (ex: feat/isolated-worker)",
                    )}
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    style={{ flex: 1, minWidth: "220px" }}
                  />
                  <select
                    value={newStrategy}
                    onChange={(e) =>
                      setNewStrategy(e.target.value as "isolated" | "branch" | "share")
                    }
                    style={{ minWidth: "140px" }}
                  >
                    <option value="isolated">{tr("Isolated worktree", "Worktree isolé")}</option>
                    <option value="branch">{tr("Standard branch", "Branche standard")}</option>
                    <option value="share">{tr("Shared index", "Index partagé")}</option>
                  </select>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      void handleCreateWorktree();
                    }}
                  >
                    {tr("Create Worktree", "Créer le Worktree")}
                  </button>
                </div>
              </section>

              {/* Worktrees Table */}
              {worktrees.length === 0 ? (
                <Empty>
                  {tr(
                    "No active worktrees found in workspace.",
                    "Aucun worktree actif dans cet espace.",
                  )}
                </Empty>
              ) : (
                <Table
                  head={[
                    tr("Branch", "Branche"),
                    tr("Path", "Chemin"),
                    tr("Strategy", "Stratégie"),
                    tr("Status", "Statut"),
                    tr("Created", "Créé"),
                    tr("Actions", "Actions"),
                  ]}
                >
                  {worktrees.map((wt) => (
                    <tr key={wt.id}>
                      <td>
                        <strong>{wt.branch}</strong>
                        {wt.baseBranch && <small className="muted"> ({wt.baseBranch})</small>}
                      </td>
                      <td>
                        <code>{wt.path}</code>
                      </td>
                      <td>
                        <span className="badge">{wt.strategy ?? "isolated"}</span>
                      </td>
                      <td>
                        <State
                          tone={
                            wt.status === "active"
                              ? "green"
                              : wt.status === "dirty"
                                ? "yellow"
                                : "red"
                          }
                          label={wt.status}
                        />
                      </td>
                      <td>{formatAge(wt.createdAt)}</td>
                      <td>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button
                            type="button"
                            className="button compact"
                            onClick={() => {
                              void handleInspectWorktree(wt);
                            }}
                          >
                            {tr("Status", "Statut")}
                          </button>
                          <button
                            type="button"
                            className="button compact primary"
                            onClick={() => {
                              void handleHandoff(wt);
                            }}
                          >
                            {tr("Handoff", "Handoff")}
                          </button>
                          <button
                            type="button"
                            className="button compact danger"
                            onClick={() => {
                              void handleRemoveWorktree(wt);
                            }}
                          >
                            {tr("Prune", "Supprimer")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}

              {/* Worktree Status Inspection Box */}
              {inspectedStatus && (
                <div
                  className="card"
                  style={{ marginTop: "1.5rem", borderLeft: "4px solid var(--accent-color)" }}
                >
                  <h4>
                    {tr("Worktree Detailed Status", "Statut Détaillé du Worktree")} :{" "}
                    <code>{inspectedStatus.path}</code>
                  </h4>
                  <div style={{ display: "flex", gap: "1rem", margin: "0.75rem 0" }}>
                    <span>
                      <strong>{tr("Clean", "Propre")}:</strong>{" "}
                      {inspectedStatus.status.clean ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: "#22c55e" }}>
                          <IconCheck size={14} color="#22c55e" /> {tr("Yes", "Oui")}
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: "#f59e0b" }}>
                          <IconWarning size={14} color="#f59e0b" /> {tr("Modified", "Modifié")}
                        </span>
                      )}
                    </span>
                    <span>
                      <strong>{tr("Staged", "Indexés")}:</strong>{" "}
                      {inspectedStatus.status.stagedCount}
                    </span>
                    <span>
                      <strong>{tr("Unstaged", "Non indexés")}:</strong>{" "}
                      {inspectedStatus.status.unstagedCount}
                    </span>
                    <span>
                      <strong>{tr("Untracked", "Non suivis")}:</strong>{" "}
                      {inspectedStatus.status.untrackedCount}
                    </span>
                  </div>
                  {inspectedStatus.status.files.length > 0 && (
                    <ul
                      style={{
                        maxHeight: "150px",
                        overflowY: "auto",
                        fontFamily: "monospace",
                        fontSize: "0.85rem",
                      }}
                    >
                      {inspectedStatus.status.files.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className="button compact"
                    onClick={() => setInspectedStatus(null)}
                  >
                    {tr("Close", "Fermer")}
                  </button>
                </div>
              )}
            </>
          )}
        </Section>
      )}

      {/* TAB 2: CHECKPOINTS */}
      {activeTab === "checkpoints" && (
        <>
          <div
            style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1.5rem" }}
          >
            <label htmlFor="thread-id-input">
              <strong>{tr("Thread / Mission ID:", "ID Thread / Mission :")}</strong>
            </label>
            <input
              id="thread-id-input"
              type="text"
              value={threadId}
              onChange={(e) => setThreadId(e.target.value)}
              style={{ width: "240px" }}
            />
            <button
              type="button"
              className="button secondary"
              onClick={() => checkpointsState.reload()}
            >
              {tr("Refresh Checkpoints", "Actualiser")}
            </button>
          </div>

          <Section state={checkpointsState}>
            {({ checkpoints }) => (
              <>
                {checkpoints.length === 0 ? (
                  <Empty>
                    {tr(
                      `No checkpoints recorded for thread "${threadId}". Checkpoints are captured automatically at each turn of execution.`,
                      `Aucun checkpoint enregistré pour le thread "${threadId}". Les points de sauvegarde sont créés automatiquement à chaque tour d'exécution.`,
                    )}
                  </Empty>
                ) : (
                  <Table
                    head={[
                      tr("Turn", "Tour"),
                      tr("Git Ref", "Référence Git"),
                      tr("Snapshot SHA", "Snapshot SHA"),
                      tr("Description", "Description"),
                      tr("Saved At", "Enregistré à"),
                      tr("Actions", "Actions"),
                    ]}
                  >
                    {checkpoints.map((cp: CheckpointDto) => (
                      <tr key={cp.id}>
                        <td>
                          <strong>#{cp.turnCount}</strong>
                        </td>
                        <td>
                          <code>{cp.gitRef.replace("refs/nexus-checkpoints/", "")}</code>
                        </td>
                        <td>
                          <code>{cp.snapshotSha.slice(0, 7)}</code>
                        </td>
                        <td>
                          {cp.description ?? (
                            <span className="muted">
                              {tr("Automatic turn checkpoint", "Checkpoint de tour automatique")}
                            </span>
                          )}
                        </td>
                        <td>{formatAge(cp.createdAt)}</td>
                        <td>
                          <div style={{ display: "flex", gap: "0.5rem" }}>
                            <button
                              type="button"
                              className="button compact"
                              onClick={() => {
                                void handleInspectDiff(cp.turnCount);
                              }}
                            >
                              {tr("View Diff", "Diff")}
                            </button>
                            <button
                              type="button"
                              className="button compact danger"
                              onClick={() => {
                                void handleRestoreTurn(cp.turnCount);
                              }}
                            >
                              {tr("Rollback to this turn", "Restaurer à ce tour")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}

                {/* Diff Viewer Card */}
                {activeDiff && (
                  <div className="card" style={{ marginTop: "1.5rem" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <h4>
                        {tr("Turn Diff Inspection", "Inspection du Diff de Tour")} : Turn #
                        {activeDiff.fromTurnCount} <IconArrowRight size={13} style={{ display: "inline-block", verticalAlign: "middle" }} /> #{activeDiff.toTurnCount}
                      </h4>
                      <button
                        type="button"
                        className="button compact"
                        onClick={() => setActiveDiff(null)}
                      >
                        {tr("Close", "Fermer")}
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: "1rem", margin: "0.5rem 0" }}>
                      <span className="pnl-positive">
                        +{activeDiff.insertions} {tr("insertions", "ajouts")}
                      </span>
                      <span className="pnl-negative">
                        -{activeDiff.deletions} {tr("deletions", "suppressions")}
                      </span>
                      <span>
                        <strong>{tr("Files changed", "Fichiers modifiés")}:</strong>{" "}
                        {activeDiff.filesChanged.length}
                      </span>
                    </div>
                    <pre
                      style={{
                        backgroundColor: "var(--code-bg, #0d1117)",
                        padding: "1rem",
                        borderRadius: "6px",
                        maxHeight: "350px",
                        overflowY: "auto",
                        fontSize: "0.85rem",
                      }}
                    >
                      {activeDiff.diff ||
                        tr(
                          "(No diff between selected checkpoints)",
                          "(Aucune différence entre les checkpoints sélectionnés)",
                        )}
                    </pre>
                  </div>
                )}
              </>
            )}
          </Section>
        </>
      )}

      {/* TAB 3: SOURCE CONTROL & PRs */}
      {activeTab === "source-control" && (
        <Section state={scLinksState}>
          {({ links }) => (
            <>
              {/* Link PR Form */}
              <section className="settings-panel" style={{ marginBottom: "1.5rem" }}>
                <h3>{tr("Link a Remote Pull Request", "Lier une Pull Request Distante")}</h3>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    type="text"
                    placeholder={tr(
                      "Repository URL (e.g. https://github.com/adlanehzx/Nexus)",
                      "URL du dépôt (ex: https://github.com/adlanehzx/Nexus)",
                    )}
                    value={prUrl}
                    onChange={(e) => setPrUrl(e.target.value)}
                    style={{ flex: 2, minWidth: "260px" }}
                  />
                  <input
                    type="text"
                    placeholder={tr(
                      "Branch (e.g. feat/t3code-deep-fusion)",
                      "Branche (ex: feat/t3code-deep-fusion)",
                    )}
                    value={prBranch}
                    onChange={(e) => setPrBranch(e.target.value)}
                    style={{ flex: 1, minWidth: "180px" }}
                  />
                  <input
                    type="number"
                    placeholder={tr("PR # (optional)", "N° PR (optionnel)")}
                    value={prNumber}
                    onChange={(e) => setPrNumber(e.target.value)}
                    style={{ width: "110px" }}
                  />
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      void handleLinkPr();
                    }}
                  >
                    {tr("Link Pull Request", "Lier la PR")}
                  </button>
                </div>
              </section>

              {/* PR Links Table */}
              {links.length === 0 ? (
                <Empty>{tr("No pull requests linked.", "Aucune pull request liée.")}</Empty>
              ) : (
                <Table
                  head={[
                    tr("Repository", "Dépôt"),
                    tr("Branch", "Branche"),
                    tr("PR #", "N° PR"),
                    tr("CI Checks", "Vérifications CI"),
                    tr("Review", "Revue"),
                    tr("Watch", "Surveillance"),
                    tr("Actions", "Actions"),
                  ]}
                >
                  {links.map((link) => (
                    <tr key={link.id}>
                      <td>
                        <strong>{link.provider}</strong>
                        <br />
                        <small className="muted">{link.repoUrl}</small>
                      </td>
                      <td>
                        <code>{link.branch}</code>
                      </td>
                      <td>{link.pullRequestNumber ? `#${link.pullRequestNumber}` : "-"}</td>
                      <td>
                        <State
                          tone={
                            link.checksState === "success"
                              ? "green"
                              : link.checksState === "pending"
                                ? "yellow"
                                : link.checksState === "failure"
                                  ? "red"
                                  : "gray"
                          }
                          label={link.checksState}
                        />
                      </td>
                      <td>
                        <State
                          tone={
                            link.reviewState === "approved"
                              ? "green"
                              : link.reviewState === "changes_requested"
                                ? "red"
                                : "yellow"
                          }
                          label={link.reviewState}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`button compact ${link.watched ? "primary" : "secondary"}`}
                          onClick={() => {
                            void handleToggleWatch(link);
                          }}
                        >
                          {link.watched ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                              <IconEye size={13} />
                              {tr("Watching", "Surveillé")}
                            </span>
                          ) : (
                            tr("Watch", "Surveiller")
                          )}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button compact danger"
                          onClick={() => {
                            void handleUnlink(link);
                          }}
                        >
                          {tr("Unlink", "Détacher")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
        </Section>
      )}
    </div>
  );
}
