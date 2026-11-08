import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConversationSummary } from "../lib/api.js";
import {
  CONVERSATION_TITLE_MAX,
  filterConversations,
  groupConversationsByRecency,
  type LoadStatus,
  type RecencyGroup,
} from "../lib/conversations.js";
import { useI18n } from "./i18n/index.js";
import {
  IconCheck,
  IconClose,
  IconMessage,
  IconNote,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSidebar,
  IconTrash,
} from "./icons.js";

export interface ConversationSidebarProps {
  conversations: readonly ConversationSummary[];
  activeId: string | null;
  /** Conversation whose reply NEXUS is still producing. */
  busyId: string | null;
  status: LoadStatus;
  error: string | null;
  hasMore: boolean;
  collapsed: boolean;
  /** Narrow host: the open panel floats over the chat instead of beside it. */
  overlay: boolean;
  /** Reference instant for the date groups; tests pin it. */
  now?: Date;
  onToggle: () => void;
  onNew: () => void;
  onSelect: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => Promise<boolean>;
  onDelete: (conversationId: string) => Promise<boolean>;
  onLoadMore: () => void;
  onRetry: () => void;
}

const GROUP_LABELS: Record<RecencyGroup, readonly [en: string, fr: string]> = {
  today: ["Today", "Aujourd'hui"],
  yesterday: ["Yesterday", "Hier"],
  week: ["Previous 7 days", "7 derniers jours"],
  month: ["Previous 30 days", "30 derniers jours"],
  older: ["Older", "Plus anciennes"],
};

/**
 * Conversation history beside the chat.
 *
 * Presentational: every write goes through the callbacks, so the rules live in
 * `ConversationHistory` and this component holds only what is being typed.
 */
export function ConversationSidebar(props: ConversationSidebarProps) {
  const { tr } = useI18n();
  const panelId = useId();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editingId === null) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [editingId]);

  // A destructive question starts on its safe answer.
  useEffect(() => {
    if (confirmingId !== null) keepButtonRef.current?.focus();
  }, [confirmingId]);

  const visible = filterConversations(props.conversations, query);
  const groups = groupConversationsByRecency(visible, props.now ?? new Date());
  const loadingFirstPage = props.status === "loading" && props.conversations.length === 0;
  const untitled = tr("Untitled conversation", "Conversation sans titre");

  const startEditing = (conversation: ConversationSummary) => {
    setConfirmingId(null);
    setEditingId(conversation.id);
    setDraftTitle(conversation.title);
  };

  const stopEditing = () => {
    setEditingId(null);
    setDraftTitle("");
  };

  const submitRename = (event: FormEvent<HTMLFormElement>, conversationId: string) => {
    event.preventDefault();
    const title = draftTitle.trim();
    if (title.length === 0) return;
    // The rename is optimistic in the store: the row reads right at once and is
    // put back, with the reason shown above the list, if the server refuses.
    void props.onRename(conversationId, title);
    stopEditing();
  };

  const confirmDelete = async (conversationId: string) => {
    setDeletingId(conversationId);
    await props.onDelete(conversationId);
    setDeletingId(null);
    setConfirmingId(null);
  };

  const cancelOnEscape = (event: KeyboardEvent, cancel: () => void) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  const toggleLabel = props.collapsed
    ? tr("Show conversation history", "Afficher l'historique des conversations")
    : tr("Hide conversation history", "Masquer l'historique des conversations");

  return (
    <aside
      className={`chat-history${props.collapsed ? " collapsed" : ""}${props.overlay ? " overlay" : ""}`}
      aria-label={tr("Conversation history", "Historique des conversations")}
    >
      <div className="chat-history-header">
        <button
          type="button"
          className="chat-history-icon-btn"
          onClick={props.onToggle}
          aria-expanded={!props.collapsed}
          aria-controls={panelId}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <IconSidebar size={15} />
        </button>
        {props.collapsed ? null : (
          <span className="chat-history-heading">{tr("Conversations", "Conversations")}</span>
        )}
        <button
          type="button"
          className="chat-history-new"
          onClick={props.onNew}
          aria-label={tr("New conversation", "Nouvelle conversation")}
          title={tr("New conversation", "Nouvelle conversation")}
        >
          <IconPlus size={14} />
          {props.collapsed ? null : <span>{tr("New", "Nouvelle")}</span>}
        </button>
      </div>

      {props.collapsed ? null : (
        <div className="chat-history-panel" id={panelId}>
          <label className="chat-history-search">
            <IconSearch size={13} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("Search conversations", "Rechercher une conversation")}
              aria-label={tr("Search conversations", "Rechercher une conversation")}
            />
          </label>

          {props.error === null ? null : (
            <div className="chat-history-error" role="alert">
              <span>{props.error}</span>
              {props.status === "error" ? (
                <button type="button" className="chat-history-retry" onClick={props.onRetry}>
                  <IconRefresh size={12} />
                  <span>{tr("Retry", "Réessayer")}</span>
                </button>
              ) : null}
            </div>
          )}

          <nav
            className="chat-history-list"
            aria-label={tr("Saved conversations", "Conversations enregistrées")}
            aria-busy={props.status === "loading"}
          >
            {loadingFirstPage ? (
              <div
                className="chat-history-skeleton"
                role="status"
                aria-label={tr("Loading", "Chargement")}
              >
                <span />
                <span />
                <span />
              </div>
            ) : null}

            {groups.map(({ group, items }) => (
              <section key={group} className="chat-history-group">
                <h3 className="chat-history-group-label">
                  {tr(GROUP_LABELS[group][0], GROUP_LABELS[group][1])}
                </h3>
                <ul>
                  {items.map((conversation) => {
                    const active = conversation.id === props.activeId;
                    const busy = conversation.id === props.busyId;
                    const title =
                      conversation.title.trim().length > 0 ? conversation.title : untitled;
                    return (
                      <li
                        key={conversation.id}
                        className={`chat-history-row${active ? " active" : ""}${busy ? " busy" : ""}`}
                      >
                        {editingId === conversation.id ? (
                          <form
                            className="chat-history-edit"
                            onSubmit={(event) => submitRename(event, conversation.id)}
                          >
                            <input
                              ref={editInputRef}
                              value={draftTitle}
                              maxLength={CONVERSATION_TITLE_MAX}
                              aria-label={tr("Conversation title", "Titre de la conversation")}
                              onChange={(event) => setDraftTitle(event.target.value)}
                              onKeyDown={(event) => cancelOnEscape(event, stopEditing)}
                            />
                            <button
                              type="submit"
                              className="chat-history-action"
                              disabled={draftTitle.trim().length === 0}
                              aria-label={tr("Save title", "Enregistrer le titre")}
                              title={tr("Save title", "Enregistrer le titre")}
                            >
                              <IconCheck size={13} />
                            </button>
                            <button
                              type="button"
                              className="chat-history-action"
                              onClick={stopEditing}
                              aria-label={tr("Cancel renaming", "Annuler le renommage")}
                              title={tr("Cancel", "Annuler")}
                            >
                              <IconClose size={13} />
                            </button>
                          </form>
                        ) : confirmingId === conversation.id ? (
                          <div
                            className="chat-history-confirm"
                            role="group"
                            aria-label={tr("Confirm deletion", "Confirmer la suppression")}
                            onKeyDown={(event) =>
                              cancelOnEscape(event, () => setConfirmingId(null))
                            }
                          >
                            <span className="chat-history-confirm-text">
                              {tr("Delete for good?", "Supprimer définitivement ?")}
                            </span>
                            <button
                              type="button"
                              className="chat-history-action danger"
                              disabled={deletingId === conversation.id}
                              onClick={() => void confirmDelete(conversation.id)}
                              aria-label={tr("Delete conversation", "Supprimer la conversation")}
                              title={tr("Delete", "Supprimer")}
                            >
                              <IconTrash size={13} />
                            </button>
                            <button
                              ref={keepButtonRef}
                              type="button"
                              className="chat-history-action"
                              disabled={deletingId === conversation.id}
                              onClick={() => setConfirmingId(null)}
                              aria-label={tr("Keep conversation", "Conserver la conversation")}
                              title={tr("Keep", "Conserver")}
                            >
                              <IconClose size={13} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="chat-history-item"
                              aria-current={active ? "true" : undefined}
                              onClick={() => props.onSelect(conversation.id)}
                              title={title}
                            >
                              <span className="chat-history-item-icon" aria-hidden="true">
                                {busy ? (
                                  <span className="chat-history-live" />
                                ) : (
                                  <IconMessage size={13} />
                                )}
                              </span>
                              <span className="chat-history-item-title">{title}</span>
                              {busy ? (
                                <span className="chat-history-sr">
                                  {tr("NEXUS is replying", "NEXUS est en train de répondre")}
                                </span>
                              ) : null}
                            </button>
                            <div className="chat-history-row-actions">
                              <button
                                type="button"
                                className="chat-history-action"
                                onClick={() => startEditing(conversation)}
                                aria-label={tr("Rename conversation", "Renommer la conversation")}
                                title={tr("Rename", "Renommer")}
                              >
                                <IconNote size={13} />
                              </button>
                              <button
                                type="button"
                                className="chat-history-action danger"
                                onClick={() => {
                                  setEditingId(null);
                                  setConfirmingId(conversation.id);
                                }}
                                aria-label={tr("Delete conversation", "Supprimer la conversation")}
                                title={tr("Delete", "Supprimer")}
                              >
                                <IconTrash size={13} />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {props.status !== "loading" && props.status !== "idle" && visible.length === 0 ? (
              <p className="chat-history-empty">
                {query.trim().length > 0
                  ? tr("No conversation matches.", "Aucune conversation ne correspond.")
                  : tr(
                      "No conversations yet. Your exchanges with NEXUS will be kept here.",
                      "Aucune conversation pour l'instant. Vos échanges avec NEXUS seront conservés ici.",
                    )}
              </p>
            ) : null}

            {props.hasMore ? (
              <button
                type="button"
                className="chat-history-more"
                onClick={props.onLoadMore}
                disabled={props.status === "loading"}
              >
                {props.status === "loading"
                  ? tr("Loading…", "Chargement…")
                  : tr("Load older conversations", "Charger les conversations plus anciennes")}
              </button>
            ) : null}
          </nav>
        </div>
      )}
    </aside>
  );
}
