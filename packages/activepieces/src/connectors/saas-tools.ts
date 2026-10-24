import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export interface ConnectorContext {
  resolveSecret: (vaultRef: string) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Communication Tools (Slack, Discord, Teams, Telegram, Notion)
// ─────────────────────────────────────────────────────────────────────────────

// Slack
const slackReadInput = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/slack/bot_token"),
});
export const slackReadMessagesTool: ToolDefinition<
  z.infer<typeof slackReadInput>,
  { messages: { id: string; user: string; text: string; timestamp: string }[] }
> = {
  name: "slack.read_messages",
  description: "Reads recent messages from a designated Slack channel without side effects.",
  riskLevel: "SAFE",
  requiredPermissions: ["slack.read"],
  requiresConfirmation: false,
  inputSchema: slackReadInput,
  outputSchema: z.object({
    messages: z.array(
      z.object({ id: z.string(), user: z.string(), text: z.string(), timestamp: z.string() }),
    ),
  }),
  summarize: (input) => `Read up to ${input.limit} messages from Slack channel #${input.channelId}`,
  execute: async (input) => {
    await Promise.resolve();
    return {
      messages: [
        {
          id: "msg-1",
          user: "U12345",
          text: `Sample message from channel ${input.channelId}`,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  },
};

const slackPostInput = z.object({
  channelId: z.string().min(1),
  text: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/slack/bot_token"),
});
export const slackPostMessageTool: ToolDefinition<
  z.infer<typeof slackPostInput>,
  { success: boolean; messageId: string }
> = {
  name: "slack.post_message",
  description:
    "Posts a message to a Slack channel. Mutable external action requiring user confirmation.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["slack.write"],
  requiresConfirmation: true,
  inputSchema: slackPostInput,
  outputSchema: z.object({ success: z.boolean(), messageId: z.string() }),
  summarize: (input) =>
    `Post message to Slack channel #${input.channelId}: "${input.text.slice(0, 40)}"`,
  execute: async () => {
    await Promise.resolve();
    return { success: true, messageId: `msg-${Date.now()}` };
  },
};

// Discord
const discordSendInput = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/discord/token"),
});
export const discordSendMessageTool: ToolDefinition<
  z.infer<typeof discordSendInput>,
  { success: boolean; messageId: string }
> = {
  name: "discord.send_message",
  description: "Sends a message to a Discord channel. Mutable action requiring confirmation.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["discord.write"],
  requiresConfirmation: true,
  inputSchema: discordSendInput,
  outputSchema: z.object({ success: z.boolean(), messageId: z.string() }),
  summarize: (input) => `Send Discord message to channel ${input.channelId}`,
  execute: async () => {
    await Promise.resolve();
    return { success: true, messageId: `disc-${Date.now()}` };
  },
};

// Teams
const teamsPostInput = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  content: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/teams/token"),
});
export const teamsPostMessageTool: ToolDefinition<
  z.infer<typeof teamsPostInput>,
  { success: boolean; messageId: string }
> = {
  name: "teams.post_message",
  description: "Posts a message to a Microsoft Teams channel.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["teams.write"],
  requiresConfirmation: true,
  inputSchema: teamsPostInput,
  outputSchema: z.object({ success: z.boolean(), messageId: z.string() }),
  summarize: (input) => `Post Teams message in ${input.teamId}/${input.channelId}`,
  execute: async () => {
    await Promise.resolve();
    return { success: true, messageId: `teams-${Date.now()}` };
  },
};

// Telegram
const telegramSendInput = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/telegram/bot_token"),
});
export const telegramSendMessageTool: ToolDefinition<
  z.infer<typeof telegramSendInput>,
  { success: boolean; messageId: string }
> = {
  name: "telegram.send_message",
  description: "Sends a Telegram message to a chat or user.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["telegram.write"],
  requiresConfirmation: true,
  inputSchema: telegramSendInput,
  outputSchema: z.object({ success: z.boolean(), messageId: z.string() }),
  summarize: (input) => `Send Telegram message to chat ${input.chatId}`,
  execute: async () => {
    await Promise.resolve();
    return { success: true, messageId: `tg-${Date.now()}` };
  },
};

// Notion
const notionReadInput = z.object({
  pageId: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/notion/token"),
});
export const notionReadPageTool: ToolDefinition<
  z.infer<typeof notionReadInput>,
  { pageId: string; title: string; content: string }
> = {
  name: "notion.read_page",
  description: "Reads page contents from Notion.",
  riskLevel: "SAFE",
  requiredPermissions: ["notion.read"],
  requiresConfirmation: false,
  inputSchema: notionReadInput,
  outputSchema: z.object({ pageId: z.string(), title: z.string(), content: z.string() }),
  summarize: (input) => `Read Notion page ${input.pageId}`,
  execute: async (input) => {
    await Promise.resolve();
    return {
      pageId: input.pageId,
      title: "Meeting Notes",
      content: "Notes content",
    };
  },
};

const notionUpdateInput = z.object({
  pageId: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/notion/token"),
});
export const notionUpdatePageTool: ToolDefinition<
  z.infer<typeof notionUpdateInput>,
  { success: boolean; pageId: string }
> = {
  name: "notion.update_page",
  description: "Updates properties of a Notion page.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["notion.write"],
  requiresConfirmation: true,
  inputSchema: notionUpdateInput,
  outputSchema: z.object({ success: z.boolean(), pageId: z.string() }),
  summarize: (input) => `Update Notion page ${input.pageId}`,
  execute: async (input) => {
    await Promise.resolve();
    return { success: true, pageId: input.pageId };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Project Management Tools (Linear, Jira, Trello)
// ─────────────────────────────────────────────────────────────────────────────

// Linear
const linearCreateIssueInput = z.object({
  teamKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/linear/api_key"),
});
export const linearCreateIssueTool: ToolDefinition<
  z.infer<typeof linearCreateIssueInput>,
  { issueId: string; issueKey: string; url: string }
> = {
  name: "linear.create_issue",
  description: "Creates an issue in Linear project tracking.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["linear.write"],
  requiresConfirmation: true,
  inputSchema: linearCreateIssueInput,
  outputSchema: z.object({ issueId: z.string(), issueKey: z.string(), url: z.string() }),
  summarize: (input) => `Create Linear issue: "${input.title}" in team ${input.teamKey}`,
  execute: async (input) => {
    await Promise.resolve();
    return {
      issueId: "lin-123",
      issueKey: `${input.teamKey}-42`,
      url: `https://linear.app/issue/${input.teamKey}-42`,
    };
  },
};

// Jira
const jiraTransitionInput = z.object({
  issueKey: z.string().min(1),
  transitionId: z.string().min(1),
  comment: z.string().optional(),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/jira/token"),
});
export const jiraTransitionIssueTool: ToolDefinition<
  z.infer<typeof jiraTransitionInput>,
  { success: boolean; issueKey: string }
> = {
  name: "jira.transition_issue",
  description: "Transitions the status of a Jira issue.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["jira.write"],
  requiresConfirmation: true,
  inputSchema: jiraTransitionInput,
  outputSchema: z.object({ success: z.boolean(), issueKey: z.string() }),
  summarize: (input) =>
    `Transition Jira issue ${input.issueKey} to transition ${input.transitionId}`,
  execute: async (input) => {
    await Promise.resolve();
    return { success: true, issueKey: input.issueKey };
  },
};

// Trello
const trelloCreateCardInput = z.object({
  listId: z.string().min(1),
  name: z.string().min(1),
  desc: z.string().optional(),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/trello/token"),
});
export const trelloCreateCardTool: ToolDefinition<
  z.infer<typeof trelloCreateCardInput>,
  { cardId: string; cardUrl: string }
> = {
  name: "trello.create_card",
  description: "Creates a new card on a Trello list.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["trello.write"],
  requiresConfirmation: true,
  inputSchema: trelloCreateCardInput,
  outputSchema: z.object({ cardId: z.string(), cardUrl: z.string() }),
  summarize: (input) => `Create Trello card "${input.name}" on list ${input.listId}`,
  execute: async (input) => {
    await Promise.resolve();
    return {
      cardId: "c-789",
      cardUrl: `https://trello.com/c/sample-${input.name}`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cloud Storage Tools (Google Drive, Dropbox, OneDrive)
// ─────────────────────────────────────────────────────────────────────────────

// Google Drive
const gdriveListInput = z.object({
  folderId: z.string().default("root"),
  pageSize: z.number().min(1).max(100).default(20),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/google/drive_token"),
});
export const gdriveListFilesTool: ToolDefinition<
  z.infer<typeof gdriveListInput>,
  { files: { id: string; name: string; mimeType: string }[] }
> = {
  name: "gdrive.list_files",
  description: "Lists files in Google Drive folder without modification.",
  riskLevel: "SAFE",
  requiredPermissions: ["gdrive.read"],
  requiresConfirmation: false,
  inputSchema: gdriveListInput,
  outputSchema: z.object({
    files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string() })),
  }),
  summarize: (input) => `List files in Google Drive folder ${input.folderId}`,
  execute: async () => {
    await Promise.resolve();
    return {
      files: [
        { id: "f-1", name: "Report.pdf", mimeType: "application/pdf" },
        { id: "f-2", name: "Budget.xlsx", mimeType: "application/vnd.ms-excel" },
      ],
    };
  },
};

const gdriveUploadInput = z.object({
  fileName: z.string().min(1),
  contentBase64: z.string().min(1),
  mimeType: z.string().default("application/octet-stream"),
  parentFolderId: z.string().optional(),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/google/drive_token"),
});
export const gdriveUploadFileTool: ToolDefinition<
  z.infer<typeof gdriveUploadInput>,
  { fileId: string; name: string }
> = {
  name: "gdrive.upload_file",
  description: "Uploads a file to Google Drive. Requires confirmation.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["gdrive.write"],
  requiresConfirmation: true,
  inputSchema: gdriveUploadInput,
  outputSchema: z.object({ fileId: z.string(), name: z.string() }),
  summarize: (input) => `Upload file "${input.fileName}" to Google Drive`,
  execute: async (input) => {
    await Promise.resolve();
    return { fileId: `gdrive-${Date.now()}`, name: input.fileName };
  },
};

// Dropbox
const dropboxUploadInput = z.object({
  path: z.string().regex(/^\//, "path must start with /"),
  contentBase64: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/dropbox/token"),
});
export const dropboxUploadFileTool: ToolDefinition<
  z.infer<typeof dropboxUploadInput>,
  { success: boolean; path: string }
> = {
  name: "dropbox.upload_file",
  description: "Uploads a file to Dropbox at specified path.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["dropbox.write"],
  requiresConfirmation: true,
  inputSchema: dropboxUploadInput,
  outputSchema: z.object({ success: z.boolean(), path: z.string() }),
  summarize: (input) => `Upload file to Dropbox at path ${input.path}`,
  execute: async (input) => {
    await Promise.resolve();
    return { success: true, path: input.path };
  },
};

// OneDrive
const onedriveUploadInput = z.object({
  itemPath: z.string().min(1),
  contentBase64: z.string().min(1),
  vaultRef: z
    .string()
    .regex(/^vault:\/\/nexus\//)
    .default("vault://nexus/onedrive/token"),
});
export const onedriveUploadItemTool: ToolDefinition<
  z.infer<typeof onedriveUploadInput>,
  { success: boolean; itemPath: string }
> = {
  name: "onedrive.upload_item",
  description: "Uploads an item to Microsoft OneDrive.",
  riskLevel: "MEDIUM",
  requiredPermissions: ["onedrive.write"],
  requiresConfirmation: true,
  inputSchema: onedriveUploadInput,
  outputSchema: z.object({ success: z.boolean(), itemPath: z.string() }),
  summarize: (input) => `Upload item to OneDrive at ${input.itemPath}`,
  execute: async (input) => {
    await Promise.resolve();
    return { success: true, itemPath: input.itemPath };
  },
};

export const ALL_SAAS_TOOLS: AnyToolDefinition[] = [
  slackReadMessagesTool,
  slackPostMessageTool,
  discordSendMessageTool,
  teamsPostMessageTool,
  telegramSendMessageTool,
  notionReadPageTool,
  notionUpdatePageTool,
  linearCreateIssueTool,
  jiraTransitionIssueTool,
  trelloCreateCardTool,
  gdriveListFilesTool,
  gdriveUploadFileTool,
  dropboxUploadFileTool,
  onedriveUploadItemTool,
];
