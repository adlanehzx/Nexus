import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, DashboardApi } from "../src/lib/api.js";
import {
  ConversationSidebar,
  type ConversationSidebarProps,
} from "../src/ui/ConversationSidebar.js";
import { NexusChat } from "../src/ui/NexusChat.js";

/**
 * The history sidebar and the chat around it, rendered to static markup.
 *
 * No DOM is needed for what matters here: which conversation is marked open,
 * which one NEXUS is still answering in, what each state offers, and that the
 * icons are vector drawings rather than characters.
 */

const EMOJI = /\p{Extended_Pictographic}/u;
const now = new Date(2026, 10, 8, 15, 0);

function conversation(id: string, title: string, daysAgo: number): ConversationSummary {
  const at = new Date(2026, 10, 8 - daysAgo, 11, 0).toISOString();
  return { id, title, status: "ACTIVE", createdAt: at, updatedAt: at };
}

const conversations = [
  conversation("alpha", "Release checklist", 0),
  conversation("beta", "Budget planning", 0),
  conversation("gamma", "", 1),
];

function renderSidebar(overrides: Partial<ConversationSidebarProps> = {}): string {
  const props: ConversationSidebarProps = {
    conversations,
    activeId: "beta",
    busyId: "alpha",
    status: "ready",
    error: null,
    hasMore: false,
    collapsed: false,
    overlay: false,
    now,
    onToggle: () => undefined,
    onNew: () => undefined,
    onSelect: () => undefined,
    onRename: () => Promise.resolve(true),
    onDelete: () => Promise.resolve(true),
    onLoadMore: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ConversationSidebar, props));
}

/** The `<li>` of the row whose title is `title`. */
function row(markup: string, title: string): string {
  return markup.split("<li").find((chunk) => chunk.includes(`>${title}<`)) ?? "";
}

describe("ConversationSidebar", () => {
  it("groups conversations by day and marks the open one", () => {
    const markup = renderSidebar();

    expect(markup.indexOf("Today")).toBeLessThan(markup.indexOf("Release checklist"));
    expect(markup.indexOf("Yesterday")).toBeGreaterThan(markup.indexOf("Budget planning"));
    expect(markup.match(/aria-current="true"/g)).toHaveLength(1);
    expect(row(markup, "Budget planning")).toContain('aria-current="true"');
    expect(row(markup, "Budget planning")).toContain("chat-history-row active");
  });

  it("shows which conversation NEXUS is still answering in", () => {
    const markup = renderSidebar();

    expect(row(markup, "Release checklist")).toContain("chat-history-live");
    expect(row(markup, "Release checklist")).toContain("NEXUS is replying");
    expect(row(markup, "Budget planning")).not.toContain("chat-history-live");
  });

  it("names an untitled conversation instead of leaving a blank row", () => {
    expect(row(renderSidebar(), "Untitled conversation")).toContain("chat-history-item");
  });

  it("offers rename and delete on every row", () => {
    const markup = renderSidebar();

    expect(markup.match(/aria-label="Rename conversation"/g)).toHaveLength(3);
    expect(markup.match(/aria-label="Delete conversation"/g)).toHaveLength(3);
  });

  it("collapses to a rail that still opens the history and starts a conversation", () => {
    const markup = renderSidebar({ collapsed: true });

    expect(markup).not.toContain("chat-history-list");
    expect(markup).not.toContain("Release checklist");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Show conversation history"');
    expect(markup).toContain('aria-label="New conversation"');
  });

  it("offers a retry when the list cannot be loaded", () => {
    const markup = renderSidebar({
      conversations: [],
      status: "error",
      error: "Request failed.",
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Request failed.");
    expect(markup).toContain("Retry");
  });

  it("explains an empty history, and pages through a long one", () => {
    expect(renderSidebar({ conversations: [] })).toContain("No conversations yet.");
    expect(renderSidebar({ conversations: [], status: "loading" })).toContain(
      "chat-history-skeleton",
    );
    expect(renderSidebar({ hasMore: true })).toContain("Load older conversations");
    expect(renderSidebar({ hasMore: false })).not.toContain("Load older conversations");
  });

  it("draws its icons as vector graphics, never as emoji", () => {
    for (const markup of [renderSidebar(), renderSidebar({ collapsed: true })]) {
      expect(markup).toContain("<svg");
      expect(markup).not.toMatch(EMOJI);
    }
  });
});

describe("NexusChat with its history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Never called during a static render: effects do not run there. */
  const api = {} as DashboardApi;

  function renderChat(href: string): string {
    vi.stubGlobal("window", {
      location: { href },
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    });
    return renderToStaticMarkup(createElement(NexusChat, { api }));
  }

  it("opens on a new conversation beside its history", () => {
    const markup = renderChat("https://nexus.local/#chat");

    expect(markup).toContain('class="nexus-chat-shell"');
    expect(markup).toContain('aria-label="Conversation history"');
    expect(markup).toContain("chat-welcome");
    expect(markup).toContain('class="chat-active-title"');
    expect(markup).not.toMatch(EMOJI);
  });

  it("loads the conversation a link names instead of greeting", () => {
    const markup = renderChat(
      "https://nexus.local/?conversation=0196f3a2-7c41-7d55-9a1e-3b2c4d5e6f70#chat",
    );

    expect(markup).toContain('aria-label="Loading conversation"');
    expect(markup).not.toContain("chat-welcome");
  });
});

describe("dashboard source", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  it("contains no emoji: icons come from icons.tsx as SVG", () => {
    const offenders = walk(root)
      .filter((path) => /\.(tsx?|css)$/.test(path))
      .filter((path) => EMOJI.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(root.length));

    expect(offenders).toEqual([]);
  });
});
