import { z } from "zod";

/**
 * Scopes OAuth 2.0 officiels minimaux stricts pour Google Workspace.
 * Aucun scope excessif (pas de https://mail.google.com/ ni https://www.googleapis.com/auth/calendar complet).
 */
export const GOOGLE_WORKSPACE_SCOPES = {
  GMAIL_READONLY: "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_COMPOSE: "https://www.googleapis.com/auth/gmail.compose",
  GMAIL_SEND: "https://www.googleapis.com/auth/gmail.send",
  CALENDAR_READONLY: "https://www.googleapis.com/auth/calendar.readonly",
  CALENDAR_EVENTS: "https://www.googleapis.com/auth/calendar.events",
} as const;

export type GoogleWorkspaceScope =
  (typeof GOOGLE_WORKSPACE_SCOPES)[keyof typeof GOOGLE_WORKSPACE_SCOPES];

export const googleOAuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().positive(),
  tokenType: z.literal("Bearer").default("Bearer"),
  scope: z.string().optional(),
});
export type GoogleOAuthTokens = z.infer<typeof googleOAuthTokensSchema>;

export const googleOAuthConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecretRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
  tokensRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
  redirectUri: z
    .string()
    .url()
    .default("http://127.0.0.1:4000/api/v1/integrations/google/callback"),
});
export type GoogleOAuthConfig = z.infer<typeof googleOAuthConfigSchema>;

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  snippet: string;
  from?: string | undefined;
  to?: string[] | undefined;
  subject?: string | undefined;
  date?: string | undefined;
}

export interface GmailMessage extends GmailMessageSummary {
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  bodyText: string;
  bodyHtml?: string | undefined;
  labels: string[];
}

export interface GmailThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
  participants: string[];
  messages: GmailMessage[];
  summary?: string | undefined;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  start: string; // ISO 8601
  end: string; // ISO 8601
  attendees?: string[] | undefined;
  status?: string | undefined;
  htmlLink?: string | undefined;
}

export interface TimeSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

export interface CalendarAvailability {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  busySlots: TimeSlot[];
  freeSlots: TimeSlot[];
}
