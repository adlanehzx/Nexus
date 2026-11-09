import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/index.js";
import {
  IconActivity,
  IconCalendar,
  IconCheck,
  IconClose,
  IconExternalLink,
  IconMessage,
  IconPlus,
  IconPower,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconShield,
  IconThumbUp,
  IconWarning,
} from "../icons.js";
import type {
  AutonomyMode,
  Lab1Client,
  LinkedInAction,
  LinkedInAuditDto,
  LinkedInContentSettings,
  LinkedInEngagementDto,
  LinkedInPostDto,
  LinkedInReaction,
  LinkedInSettingsView,
} from "../../lib/lab1-client.js";
import {
  ChipListEditor,
  ErrorBanner,
  ModeSelector,
  actorBadge,
  errorMessage,
  formatDateTime,
} from "./Lab1Controls.js";

type SubTab = "settings" | "posts" | "queue" | "audit";

const REACTIONS: LinkedInReaction[] = [
  "LIKE",
  "PRAISE",
  "EMPATHY",
  "INTEREST",
  "APPRECIATION",
  "ENTERTAINMENT",
];
const DAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FR = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

/**
 * "LinkedIn" — content management on the member's behalf: configuration,
 * scheduled posts, the one-click approval queue and the audit trail.
 */
export function LinkedInPanel({ client }: { client: Lab1Client | null }) {
  const { tr, locale } = useI18n();
  const [tab, setTab] = useState<SubTab>("queue");
  const [view, setView] = useState<LinkedInSettingsView | null>(null);
  const [draft, setDraft] = useState<LinkedInContentSettings | null>(null);
  const [posts, setPosts] = useState<LinkedInPostDto[]>([]);
  const [engagements, setEngagements] = useState<LinkedInEngagementDto[]>([]);
  const [audit, setAudit] = useState<LinkedInAuditDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [composer, setComposer] = useState({ text: "", scheduledAt: "" });
  const [topic, setTopic] = useState("");
  const [target, setTarget] = useState({
    kind: "reaction" as "reaction" | "comment",
    url: "",
    text: "",
  });

  const load = useCallback(async () => {
    if (client === null) return;
    setError(null);
    try {
      const [settings, postList, engagementList, auditList] = await Promise.all([
        client.linkedInSettings(),
        client.linkedInPosts(),
        client.linkedInEngagements(),
        client.linkedInAudit(),
      ]);
      setView(settings);
      setDraft(settings.settings);
      setPosts(postList.posts);
      setEngagements(engagementList.engagements);
      setAudit(auditList.events);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (client === null) {
    return (
      <div className="lab1-panel">
        <ErrorBanner
          error={tr(
            "LinkedIn management needs a signed-in session with the NEXUS API.",
            "La gestion LinkedIn nécessite une session connectée à l'API NEXUS.",
          )}
        />
      </div>
    );
  }

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const consentValid = view?.consent.valid === true;
  const setMode = (action: LinkedInAction, mode: AutonomyMode) => {
    if (action !== "publishPost" && mode === "autonomous" && !consentValid) {
      setTab("settings");
      setError(
        tr(
          "Autonomous reactions and comments require accepting the risk warning below first.",
          "Les réactions et commentaires autonomes exigent d'accepter d'abord l'avertissement ci-dessous.",
        ),
      );
      return;
    }
    void act(
      "mode",
      () => client.updateLinkedInSettings({ modes: { [action]: mode } }),
      tr("Mode saved.", "Mode enregistré."),
    );
  };

  const queuePosts = posts.filter((p) => p.state === "awaiting_approval" || p.state === "draft");
  const scheduledPosts = posts.filter(
    (p) => p.state === "scheduled" || p.state === "publishing" || p.state === "failed",
  );
  const proposed = engagements.filter((e) => e.state === "proposed" || e.state === "failed");
  const queued = engagements.filter((e) => e.state === "queued" || e.state === "executing");

  const actionLabels: Record<LinkedInAction, string> = {
    publishPost: tr("Publish posts", "Publier des posts"),
    react: tr("React to others' posts", "Réagir aux posts"),
    comment: tr("Comment on others' posts", "Commenter les posts"),
  };

  return (
    <div className="lab1-panel" aria-label="LinkedIn">
      <ErrorBanner error={error} onRetry={() => void load()} />
      {notice !== null && (
        <div className="lab1-alert ok" role="status">
          <IconCheck size={16} color="var(--nx-ok)" />
          <div>{notice}</div>
        </div>
      )}
      {view?.connection !== null &&
        view?.connection !== undefined &&
        !view.connection.connected && (
          <div className="lab1-alert warn" role="status">
            <IconWarning size={16} color="var(--nx-warn)" />
            <div>
              {view.connection.configured
                ? tr(
                    "LinkedIn is not connected for your account: posts cannot be published until you connect it in Settings.",
                    "LinkedIn n'est pas connecté pour votre compte : aucun post ne peut être publié avant connexion dans les Paramètres.",
                  )
                : tr(
                    "The LinkedIn integration is not configured on this server: publishing will fail.",
                    "L'intégration LinkedIn n'est pas configurée sur ce serveur : la publication échouera.",
                  )}
            </div>
          </div>
        )}

      {view !== null && draft !== null && (
        <section className="lab1-card lab1-kill" data-on={draft.killSwitch}>
          <div className="lab1-row spread">
            <h3>
              <IconPower size={16} color="var(--nx-danger)" />
              {tr("LinkedIn kill switch", "Arrêt d'urgence LinkedIn")}
            </h3>
            <button
              type="button"
              className={`button ${draft.killSwitch ? "ok" : "danger"}`}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "kill",
                  () => client.updateLinkedInSettings({ killSwitch: !draft.killSwitch }),
                  draft.killSwitch
                    ? tr(
                        "Autonomous LinkedIn actions resumed.",
                        "Actions LinkedIn autonomes reprises.",
                      )
                    : tr(
                        "Autonomous LinkedIn actions paused.",
                        "Actions LinkedIn autonomes en pause.",
                      ),
                )
              }
            >
              {draft.killSwitch
                ? tr("Resume", "Reprendre")
                : tr("Pause autonomy", "Suspendre l'autonomie")}
            </button>
          </div>
          <div className="lab1-row">
            {(Object.keys(actionLabels) as LinkedInAction[]).map((action) => (
              <span key={action} className="lab1-badge">
                {actionLabels[action]}: {view.effectiveModes[action]}
              </span>
            ))}
            <span className="lab1-badge">
              {tr("executor", "exécuteur")}: {view.executor}
            </span>
            <span className="lab1-badge">
              {tr("drafter", "rédacteur")}: {view.drafter}
            </span>
          </div>
        </section>
      )}

      <nav
        className="lab1-subtabs"
        role="tablist"
        aria-label={tr("LinkedIn views", "Vues LinkedIn")}
      >
        {(
          [
            [
              "queue",
              <IconCheck size={12} key="i" />,
              tr("Approval queue", "File de validation"),
              queuePosts.length + proposed.length,
            ],
            [
              "posts",
              <IconCalendar size={12} key="i" />,
              tr("Scheduled posts", "Posts planifiés"),
              scheduledPosts.length,
            ],
            [
              "settings",
              <IconSettings size={12} key="i" />,
              tr("Configuration", "Configuration"),
              null,
            ],
            ["audit", <IconActivity size={12} key="i" />, tr("Audit log", "Journal d'audit"), null],
          ] as const
        ).map(([id, icon, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {icon}
            {label}
            {count !== null && count > 0 && <span className="lab1-badge accent">{count}</span>}
          </button>
        ))}
        <button type="button" onClick={() => void load()} aria-label={tr("Refresh", "Actualiser")}>
          <IconRefresh size={12} />
        </button>
      </nav>

      {tab === "settings" && view !== null && draft !== null && (
        <>
          <section className="lab1-card">
            <h3>
              <IconSettings size={16} /> {tr("Mode per action", "Mode par action")}
            </h3>
            {(Object.keys(actionLabels) as LinkedInAction[]).map((action) => (
              <div className="lab1-mode-row" key={action}>
                <div>
                  <strong>{actionLabels[action]}</strong>
                  <p className="lab1-muted">
                    {action === "publishPost"
                      ? tr(
                          "Official LinkedIn Posts API (w_member_social).",
                          "API officielle LinkedIn Posts (w_member_social).",
                        )
                      : tr(
                          "Browser automation (not available through the official API for personal accounts).",
                          "Automatisation navigateur (indisponible via l'API officielle pour un compte personnel).",
                        )}
                  </p>
                </div>
                <ModeSelector
                  label={actionLabels[action]}
                  value={draft.modes[action]}
                  effective={view.effectiveModes[action]}
                  disabled={busy !== null}
                  onChange={(mode) => setMode(action, mode)}
                />
              </div>
            ))}
          </section>

          <section
            className="lab1-card"
            aria-label={tr("Automation risk", "Risque d'automatisation")}
          >
            <h3>
              <IconShield size={16} color="var(--nx-danger)" />
              {tr("Browser automation risk", "Risque de l'automatisation navigateur")}
            </h3>
            <div className="lab1-alert danger" role="note">
              <IconWarning size={18} color="var(--nx-danger)" />
              <div>
                <strong>{tr("Warning", "Avertissement")}:</strong>{" "}
                {tr(
                  view.consent.warning,
                  "Les réactions et commentaires autonomes sont exécutés par automatisation de navigateur sur votre compte LinkedIn personnel. Cela viole les Conditions d'utilisation de LinkedIn (section 8.2, accès automatisé) et peut entraîner la restriction, voire le bannissement définitif, de votre compte. En l'activant, vous acceptez ce risque.",
                )}
              </div>
            </div>
            {consentValid ? (
              <div className="lab1-row spread">
                <span className="lab1-badge warn">
                  {tr("Accepted", "Accepté")} {formatDateTime(view.consent.acceptedAt, locale)} (v
                  {view.consent.version})
                </span>
                <button
                  type="button"
                  className="button compact"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      "revoke",
                      () => client.revokeLinkedInRisk(),
                      tr(
                        "Consent withdrawn; autonomous engagement switched back to approval.",
                        "Consentement retiré ; l'engagement autonome repasse en validation.",
                      ),
                    )
                  }
                >
                  <IconClose size={12} /> {tr("Withdraw consent", "Retirer le consentement")}
                </button>
              </div>
            ) : (
              <div className="lab1-row">
                <label className="lab1-check">
                  <input
                    type="checkbox"
                    checked={consentChecked}
                    onChange={(event) => setConsentChecked(event.target.checked)}
                  />
                  {tr(
                    "I have read this warning and accept the risk of account restriction.",
                    "J'ai lu cet avertissement et j'accepte le risque de restriction du compte.",
                  )}
                </label>
                <button
                  type="button"
                  className="button danger"
                  disabled={!consentChecked || busy !== null}
                  onClick={() =>
                    void act(
                      "consent",
                      () => client.acceptLinkedInRisk(view.consent.currentVersion),
                      tr(
                        "Consent recorded with timestamp.",
                        "Consentement enregistré et horodaté.",
                      ),
                    )
                  }
                >
                  {tr("Accept the risk", "Accepter le risque")}
                </button>
              </div>
            )}
          </section>

          <PostConfigEditor
            draft={draft}
            onChange={setDraft}
            disabled={busy !== null}
            onSave={() =>
              void act(
                "posts",
                () =>
                  client.updateLinkedInSettings({
                    posts: draft.posts,
                    engagement: draft.engagement,
                  }),
                tr("Configuration saved.", "Configuration enregistrée."),
              )
            }
          />
        </>
      )}

      {tab === "queue" && (
        <>
          <section className="lab1-card">
            <div className="lab1-row spread">
              <h3>
                <IconSend size={16} /> {tr("Posts to approve", "Posts à valider")}
              </h3>
              <div className="lab1-row">
                <input
                  className="lab1-input"
                  placeholder={tr("Topic (optional)", "Sujet (optionnel)")}
                  aria-label={tr("Topic", "Sujet")}
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                />
                <button
                  type="button"
                  className="button compact primary"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      "generate",
                      () => client.generateLinkedInPost(topic),
                      tr("Draft written by Nexus.", "Brouillon rédigé par Nexus."),
                    )
                  }
                >
                  <IconPlus size={12} /> {tr("Draft a post", "Rédiger un post")}
                </button>
              </div>
            </div>
            {queuePosts.length === 0 ? (
              <p className="lab1-muted">{tr("Nothing to approve.", "Rien à valider.")}</p>
            ) : (
              <ul className="lab1-list">
                {queuePosts.map((post) => (
                  <PostItem
                    key={post.id}
                    post={post}
                    busy={busy !== null}
                    onAction={(action) =>
                      void act(
                        `${action}-${post.id}`,
                        () => client.linkedInPostAction(post.id, action),
                        action === "approve"
                          ? tr("Approved and scheduled.", "Approuvé et planifié.")
                          : tr("Done.", "Fait."),
                      )
                    }
                    onEdit={(text) =>
                      void act(
                        `edit-${post.id}`,
                        () => client.updateLinkedInPost(post.id, { text }),
                        tr("Post updated.", "Post mis à jour."),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="lab1-card">
            <div className="lab1-row spread">
              <h3>
                <IconThumbUp size={16} />{" "}
                {tr("Reactions & comments to approve", "Réactions & commentaires à valider")}
              </h3>
              <button
                type="button"
                className="button compact"
                disabled={busy !== null || !consentValid}
                title={
                  consentValid
                    ? undefined
                    : tr(
                        "Requires the automation consent.",
                        "Nécessite le consentement d'automatisation.",
                      )
                }
                onClick={() =>
                  void act(
                    "discover",
                    () => client.discoverLinkedInEngagements(5),
                    tr("Feed scanned; proposals queued.", "Fil analysé ; propositions ajoutées."),
                  )
                }
              >
                <IconSearch size={12} /> {tr("Find posts to engage with", "Trouver des posts")}
              </button>
            </div>
            <div className="lab1-row">
              <select
                className="lab1-input"
                aria-label={tr("Kind", "Type")}
                value={target.kind}
                onChange={(event) =>
                  setTarget({ ...target, kind: event.target.value as "reaction" | "comment" })
                }
              >
                <option value="reaction">{tr("Reaction", "Réaction")}</option>
                <option value="comment">{tr("Comment", "Commentaire")}</option>
              </select>
              <input
                className="lab1-input"
                style={{ flex: 1, minWidth: 240 }}
                placeholder="https://www.linkedin.com/feed/update/urn:li:activity:..."
                aria-label={tr("Post URL", "URL du post")}
                value={target.url}
                onChange={(event) => setTarget({ ...target, url: event.target.value })}
              />
              {target.kind === "comment" && (
                <input
                  className="lab1-input"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder={tr(
                    "Comment (empty = drafted by Nexus)",
                    "Commentaire (vide = rédigé par Nexus)",
                  )}
                  aria-label={tr("Comment", "Commentaire")}
                  value={target.text}
                  onChange={(event) => setTarget({ ...target, text: event.target.value })}
                />
              )}
              <button
                type="button"
                className="button compact"
                disabled={busy !== null || target.url.trim() === ""}
                onClick={() =>
                  void act(
                    "propose",
                    () =>
                      client.proposeLinkedInEngagement(
                        target.kind === "reaction"
                          ? { kind: "reaction", target: target.url.trim() }
                          : {
                              kind: "comment",
                              target: target.url.trim(),
                              ...(target.text.trim() === "" ? {} : { text: target.text.trim() }),
                            },
                      ),
                    tr("Added to the queue.", "Ajouté à la file."),
                  )
                }
              >
                <IconPlus size={12} /> {tr("Add", "Ajouter")}
              </button>
            </div>
            {proposed.length === 0 && queued.length === 0 ? (
              <p className="lab1-muted">{tr("Nothing pending.", "Rien en attente.")}</p>
            ) : (
              <ul className="lab1-list">
                {[...proposed, ...queued].map((item) => (
                  <EngagementItem
                    key={item.id}
                    item={item}
                    busy={busy !== null}
                    consentValid={consentValid}
                    onAction={(action) =>
                      void act(
                        `${action}-${item.id}`,
                        () => client.linkedInEngagementAction(item.id, action),
                        action === "approve"
                          ? tr("Executed.", "Exécuté.")
                          : action === "done"
                            ? tr("Marked as done by hand.", "Marqué comme fait à la main.")
                            : tr("Done.", "Fait."),
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {tab === "posts" && (
        <section className="lab1-card">
          <h3>
            <IconCalendar size={16} /> {tr("Scheduled posts", "Posts planifiés")}
          </h3>
          <div className="lab1-field">
            <span>{tr("Write a post yourself", "Écrire un post vous-même")}</span>
            <textarea
              value={composer.text}
              maxLength={3000}
              onChange={(event) => setComposer({ ...composer, text: event.target.value })}
            />
            <div className="lab1-row">
              <input
                className="lab1-input"
                type="datetime-local"
                aria-label={tr("Schedule at", "Planifier à")}
                value={composer.scheduledAt}
                onChange={(event) => setComposer({ ...composer, scheduledAt: event.target.value })}
              />
              <button
                type="button"
                className="button compact primary"
                disabled={busy !== null || composer.text.trim() === ""}
                onClick={() =>
                  void act(
                    "compose",
                    async () => {
                      await client.createLinkedInPost({
                        text: composer.text.trim(),
                        scheduledAt:
                          composer.scheduledAt === ""
                            ? null
                            : new Date(composer.scheduledAt).toISOString(),
                      });
                      setComposer({ text: "", scheduledAt: "" });
                    },
                    composer.scheduledAt === ""
                      ? tr("Draft saved.", "Brouillon enregistré.")
                      : tr("Post scheduled.", "Post planifié."),
                  )
                }
              >
                <IconCalendar size={12} />{" "}
                {composer.scheduledAt === ""
                  ? tr("Save draft", "Enregistrer le brouillon")
                  : tr("Schedule", "Planifier")}
              </button>
            </div>
          </div>
          {scheduledPosts.length === 0 ? (
            <p className="lab1-muted">{tr("No scheduled posts.", "Aucun post planifié.")}</p>
          ) : (
            <ul className="lab1-list">
              {scheduledPosts.map((post) => (
                <PostItem
                  key={post.id}
                  post={post}
                  busy={busy !== null}
                  onAction={(action) =>
                    void act(
                      `${action}-${post.id}`,
                      () => client.linkedInPostAction(post.id, action),
                      action === "publish"
                        ? tr("Published on LinkedIn.", "Publié sur LinkedIn.")
                        : tr("Done.", "Fait."),
                    )
                  }
                  onEdit={(text) =>
                    void act(
                      `edit-${post.id}`,
                      () => client.updateLinkedInPost(post.id, { text }),
                      tr("Post updated.", "Post mis à jour."),
                    )
                  }
                />
              ))}
            </ul>
          )}
          <h4>{tr("Published", "Publiés")}</h4>
          <ul className="lab1-list">
            {posts
              .filter((p) => p.state === "published")
              .map((post) => (
                <li className="lab1-item" key={post.id}>
                  <div className="lab1-row spread">
                    <span className="lab1-badge ok">
                      <IconCheck size={11} /> {formatDateTime(post.publishedAt, locale)}
                    </span>
                    <span className="lab1-badge">{post.externalId}</span>
                  </div>
                  <p>{post.text}</p>
                </li>
              ))}
          </ul>
        </section>
      )}

      {tab === "audit" && (
        <section className="lab1-card">
          <h3>
            <IconActivity size={16} /> {tr("Audit log", "Journal d'audit")}
          </h3>
          {audit.length === 0 ? (
            <p className="lab1-muted">{tr("No LinkedIn action yet.", "Aucune action LinkedIn.")}</p>
          ) : (
            <div className="lab1-scroll">
              <table className="lab1-table">
                <thead>
                  <tr>
                    <th>{tr("When", "Quand")}</th>
                    <th>{tr("Actor", "Acteur")}</th>
                    <th>{tr("Action", "Action")}</th>
                    <th>{tr("Outcome", "Résultat")}</th>
                    <th>{tr("Summary", "Résumé")}</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((event) => {
                    const badge = actorBadge(event.actor);
                    return (
                      <tr key={event.id}>
                        <td className="mono">{formatDateTime(event.createdAt, locale)}</td>
                        <td>
                          <span className={badge.className}>{badge.label}</span>
                        </td>
                        <td className="mono">{event.action}</td>
                        <td>
                          <span
                            className={`lab1-badge ${event.outcome === "ok" ? "ok" : event.outcome === "failed" ? "danger" : "warn"}`}
                          >
                            {event.outcome}
                          </span>
                        </td>
                        <td>{event.summary}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function postStateBadge(state: LinkedInPostDto["state"]): string {
  if (state === "published") return "lab1-badge ok";
  if (state === "failed" || state === "rejected") return "lab1-badge danger";
  if (state === "awaiting_approval" || state === "publishing") return "lab1-badge warn";
  return "lab1-badge accent";
}

function PostItem({
  post,
  busy,
  onAction,
  onEdit,
}: {
  post: LinkedInPostDto;
  busy: boolean;
  onAction: (action: "approve" | "reject" | "cancel" | "publish") => void;
  onEdit: (text: string) => void;
}) {
  const { tr, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(post.text);
  const creator = actorBadge(post.createdBy);
  return (
    <li className="lab1-item">
      <div className="lab1-row spread">
        <div className="lab1-row">
          <span className={postStateBadge(post.state)}>{post.state}</span>
          <span className={creator.className}>{creator.label}</span>
          {post.topic !== null && <span className="lab1-badge">{post.topic}</span>}
        </div>
        <span className="lab1-muted">
          <IconCalendar size={11} /> {formatDateTime(post.scheduledAt, locale)}
        </span>
      </div>
      {editing ? (
        <div className="lab1-field">
          <textarea value={text} maxLength={3000} onChange={(e) => setText(e.target.value)} />
        </div>
      ) : (
        <p>{post.text}</p>
      )}
      {post.failureReason !== null && (
        <div className="lab1-alert danger" role="alert">
          <IconWarning size={14} color="var(--nx-danger)" />
          <div>{post.failureReason}</div>
        </div>
      )}
      <div className="lab1-row">
        {editing ? (
          <>
            <button
              type="button"
              className="button compact primary"
              disabled={busy || text.trim() === ""}
              onClick={() => {
                onEdit(text.trim());
                setEditing(false);
              }}
            >
              <IconCheck size={12} /> {tr("Save", "Enregistrer")}
            </button>
            <button type="button" className="button compact" onClick={() => setEditing(false)}>
              {tr("Cancel", "Annuler")}
            </button>
          </>
        ) : (
          <>
            {(post.state === "awaiting_approval" || post.state === "draft") && (
              <button
                type="button"
                className="button compact ok"
                disabled={busy}
                onClick={() => onAction("approve")}
              >
                <IconCheck size={12} /> {tr("Approve", "Approuver")}
              </button>
            )}
            {(post.state === "scheduled" || post.state === "failed") && (
              <button
                type="button"
                className="button compact ok"
                disabled={busy}
                onClick={() => onAction("publish")}
              >
                <IconSend size={12} />{" "}
                {post.state === "failed"
                  ? tr("Retry now", "Réessayer")
                  : tr("Publish now", "Publier maintenant")}
              </button>
            )}
            {post.state !== "publishing" && (
              <button
                type="button"
                className="button compact"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                {tr("Edit", "Modifier")}
              </button>
            )}
            {(post.state === "awaiting_approval" || post.state === "draft") && (
              <button
                type="button"
                className="button compact danger"
                disabled={busy}
                onClick={() => onAction("reject")}
              >
                <IconClose size={12} /> {tr("Reject", "Rejeter")}
              </button>
            )}
            {(post.state === "scheduled" || post.state === "failed") && (
              <button
                type="button"
                className="button compact danger"
                disabled={busy}
                onClick={() => onAction("cancel")}
              >
                <IconClose size={12} /> {tr("Cancel", "Annuler")}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function EngagementItem({
  item,
  busy,
  consentValid,
  onAction,
}: {
  item: LinkedInEngagementDto;
  busy: boolean;
  consentValid: boolean;
  onAction: (action: "approve" | "reject" | "cancel" | "done") => void;
}) {
  const { tr, locale } = useI18n();
  const creator = actorBadge(item.createdBy);
  const url = item.target.startsWith("https://")
    ? item.target
    : `https://www.linkedin.com/feed/update/${item.target}/`;
  return (
    <li className="lab1-item">
      <div className="lab1-row spread">
        <div className="lab1-row">
          {item.kind === "reaction" ? <IconThumbUp size={14} /> : <IconMessage size={14} />}
          <span className={item.state === "failed" ? "lab1-badge danger" : "lab1-badge warn"}>
            {item.state}
          </span>
          <span className={creator.className}>{creator.label}</span>
          {item.reaction !== null && <span className="lab1-badge">{item.reaction}</span>}
        </div>
        <a href={url} target="_blank" rel="noopener noreferrer" className="lab1-muted">
          <IconExternalLink size={11} /> {tr("Open post", "Ouvrir le post")}
        </a>
      </div>
      {item.text !== null && <p>{item.text}</p>}
      {item.rationale !== null && <p className="lab1-muted">{item.rationale}</p>}
      {item.state === "queued" && (
        <p className="lab1-muted">
          {tr("Runs after", "S'exécute après")} {formatDateTime(item.executeAfter, locale)}
        </p>
      )}
      {item.failureReason !== null && (
        <div className={`lab1-alert ${item.state === "failed" ? "danger" : "warn"}`} role="status">
          <IconWarning size={14} />
          <div>{item.failureReason}</div>
        </div>
      )}
      <div className="lab1-row">
        {(item.state === "proposed" || item.state === "failed") && (
          <button
            type="button"
            className="button compact ok"
            disabled={busy || !consentValid}
            title={
              consentValid
                ? undefined
                : tr(
                    "Execution uses browser automation: accept the risk first, or do it yourself and mark it done.",
                    "L'exécution passe par l'automatisation navigateur : acceptez le risque, ou faites-le vous-même et marquez-le fait.",
                  )
            }
            onClick={() => onAction("approve")}
          >
            <IconCheck size={12} /> {tr("Approve & execute", "Approuver & exécuter")}
          </button>
        )}
        {item.state !== "executing" && (
          <button
            type="button"
            className="button compact"
            disabled={busy}
            onClick={() => onAction("done")}
          >
            {tr("I did it myself", "Fait moi-même")}
          </button>
        )}
        {(item.state === "proposed" || item.state === "queued") && (
          <button
            type="button"
            className="button compact danger"
            disabled={busy}
            onClick={() => onAction("reject")}
          >
            <IconClose size={12} /> {tr("Reject", "Rejeter")}
          </button>
        )}
      </div>
    </li>
  );
}

function PostConfigEditor({
  draft,
  onChange,
  onSave,
  disabled,
}: {
  draft: LinkedInContentSettings;
  onChange: (next: LinkedInContentSettings) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  const { tr, locale } = useI18n();
  const posts = draft.posts;
  const engagement = draft.engagement;
  const setPosts = (patch: Partial<LinkedInContentSettings["posts"]>) =>
    onChange({ ...draft, posts: { ...posts, ...patch } });
  const setEngagement = (patch: Partial<LinkedInContentSettings["engagement"]>) =>
    onChange({ ...draft, engagement: { ...engagement, ...patch } });
  const days = locale === "fr" ? DAYS_FR : DAYS_EN;
  const num = (value: string) => (value === "" ? 0 : Number(value));

  return (
    <>
      <section className="lab1-card">
        <h3>
          <IconSend size={16} /> {tr("Posts", "Posts")}
        </h3>
        <ChipListEditor
          label={tr("Topics", "Sujets")}
          placeholder={tr("e.g. distributed systems", "ex. systèmes distribués")}
          values={posts.topics}
          disabled={disabled}
          onChange={(topics) => setPosts({ topics })}
        />
        <div className="lab1-grid">
          <label className="lab1-field">
            {tr("Tone & voice", "Ton & voix")}
            <input value={posts.tone} onChange={(e) => setPosts({ tone: e.target.value })} />
          </label>
          <label className="lab1-field">
            {tr("Language", "Langue")}
            <input
              value={posts.language}
              onChange={(e) => setPosts({ language: e.target.value })}
            />
          </label>
          <label className="lab1-field">
            {tr("Visibility", "Visibilité")}
            <select
              value={posts.visibility}
              onChange={(e) =>
                setPosts({
                  visibility: e.target.value as LinkedInContentSettings["posts"]["visibility"],
                })
              }
            >
              <option value="PUBLIC">{tr("Public", "Public")}</option>
              <option value="CONNECTIONS">{tr("Connections only", "Relations uniquement")}</option>
            </select>
          </label>
          <label className="lab1-field">
            {tr("Max posts per week", "Posts max par semaine")}
            <input
              type="number"
              min={0}
              max={21}
              value={posts.maxPostsPerWeek}
              onChange={(e) => setPosts({ maxPostsPerWeek: num(e.target.value) })}
            />
          </label>
          <label className="lab1-field">
            {tr("Draft ahead (hours)", "Rédiger à l'avance (heures)")}
            <input
              type="number"
              min={1}
              max={168}
              value={posts.draftLeadHours}
              onChange={(e) => setPosts({ draftLeadHours: num(e.target.value) })}
            />
          </label>
          <label className="lab1-field">
            {tr("Schedule timezone", "Fuseau du planning")}
            <input
              value={posts.schedule.timezone}
              onChange={(e) =>
                setPosts({ schedule: { ...posts.schedule, timezone: e.target.value } })
              }
            />
          </label>
        </div>
        <div className="lab1-field">
          <span>{tr("Posting days", "Jours de publication")}</span>
          <div className="lab1-row">
            {days.map((label, index) => (
              <label className="lab1-check" key={label}>
                <input
                  type="checkbox"
                  checked={posts.schedule.daysOfWeek.includes(index)}
                  onChange={(e) =>
                    setPosts({
                      schedule: {
                        ...posts.schedule,
                        daysOfWeek: e.target.checked
                          ? [...posts.schedule.daysOfWeek, index].sort((a, b) => a - b)
                          : posts.schedule.daysOfWeek.filter((d) => d !== index),
                      },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <ChipListEditor
          label={tr("Posting times (HH:MM)", "Heures de publication (HH:MM)")}
          placeholder="09:00"
          values={posts.schedule.times}
          disabled={disabled}
          onChange={(times) => setPosts({ schedule: { ...posts.schedule, times } })}
        />
        <div className="lab1-grid">
          <label className="lab1-field">
            {tr("Hashtag policy", "Politique de hashtags")}
            <select
              value={posts.hashtags.policy}
              onChange={(e) =>
                setPosts({
                  hashtags: {
                    ...posts.hashtags,
                    policy: e.target
                      .value as LinkedInContentSettings["posts"]["hashtags"]["policy"],
                  },
                })
              }
            >
              <option value="none">{tr("None", "Aucun")}</option>
              <option value="fixed">{tr("Fixed list", "Liste fixe")}</option>
              <option value="generated">{tr("Generated", "Générés")}</option>
              <option value="fixed_and_generated">
                {tr("Fixed + generated", "Fixes + générés")}
              </option>
            </select>
          </label>
          <label className="lab1-field">
            {tr("Max hashtags per post", "Hashtags max par post")}
            <input
              type="number"
              min={0}
              max={10}
              value={posts.hashtags.maxPerPost}
              onChange={(e) =>
                setPosts({ hashtags: { ...posts.hashtags, maxPerPost: num(e.target.value) } })
              }
            />
          </label>
        </div>
        <ChipListEditor
          label={tr("Fixed hashtags", "Hashtags fixes")}
          placeholder="OpenSource"
          values={posts.hashtags.fixed}
          disabled={disabled}
          onChange={(fixed) => setPosts({ hashtags: { ...posts.hashtags, fixed } })}
        />
      </section>

      <section className="lab1-card">
        <h3>
          <IconThumbUp size={16} />{" "}
          {tr("Reactions & comments: rate limits", "Réactions & commentaires : limites")}
        </h3>
        <div className="lab1-grid">
          <label className="lab1-field">
            {tr("Max actions per hour", "Actions max par heure")}
            <input
              type="number"
              min={0}
              max={30}
              value={engagement.maxActionsPerHour}
              onChange={(e) => setEngagement({ maxActionsPerHour: num(e.target.value) })}
            />
          </label>
          <label className="lab1-field">
            {tr("Max actions per day", "Actions max par jour")}
            <input
              type="number"
              min={0}
              max={200}
              value={engagement.maxActionsPerDay}
              onChange={(e) => setEngagement({ maxActionsPerDay: num(e.target.value) })}
            />
          </label>
          <label className="lab1-field">
            {tr("Random delay min (s)", "Délai aléatoire min (s)")}
            <input
              type="number"
              min={0}
              value={engagement.minDelaySeconds}
              onChange={(e) => setEngagement({ minDelaySeconds: num(e.target.value) })}
            />
          </label>
          <label className="lab1-field">
            {tr("Random delay max (s)", "Délai aléatoire max (s)")}
            <input
              type="number"
              min={0}
              value={engagement.maxDelaySeconds}
              onChange={(e) => setEngagement({ maxDelaySeconds: num(e.target.value) })}
            />
          </label>
          <label className="lab1-field">
            {tr("Active from", "Actif de")}
            <input
              type="time"
              value={engagement.activeHours.start}
              onChange={(e) =>
                setEngagement({ activeHours: { ...engagement.activeHours, start: e.target.value } })
              }
            />
          </label>
          <label className="lab1-field">
            {tr("Active until", "Actif jusqu'à")}
            <input
              type="time"
              value={engagement.activeHours.end}
              onChange={(e) =>
                setEngagement({ activeHours: { ...engagement.activeHours, end: e.target.value } })
              }
            />
          </label>
          <label className="lab1-field">
            {tr("Active-hours timezone", "Fuseau des heures actives")}
            <input
              value={engagement.activeHours.timezone}
              onChange={(e) =>
                setEngagement({
                  activeHours: { ...engagement.activeHours, timezone: e.target.value },
                })
              }
            />
          </label>
          <label className="lab1-field">
            {tr("Default reaction", "Réaction par défaut")}
            <select
              value={engagement.defaultReaction}
              onChange={(e) =>
                setEngagement({ defaultReaction: e.target.value as LinkedInReaction })
              }
            >
              {REACTIONS.map((reaction) => (
                <option key={reaction} value={reaction}>
                  {reaction}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ChipListEditor
          label={tr("Engagement topics", "Sujets d'engagement")}
          placeholder={tr("e.g. Rust", "ex. Rust")}
          values={engagement.topics}
          disabled={disabled}
          onChange={(topics) => setEngagement({ topics })}
        />
        <div className="lab1-row">
          <button type="button" className="button primary" disabled={disabled} onClick={onSave}>
            <IconCheck size={14} /> {tr("Save configuration", "Enregistrer la configuration")}
          </button>
        </div>
      </section>
    </>
  );
}
