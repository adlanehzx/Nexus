import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@nexus/tools";
import type { GoogleWorkspaceClient } from "./client.js";

// ==========================================
// GMAIL SCHEMAS
// ==========================================

export const gmailSearchInputSchema = z.object({
  query: z.string().min(1).describe("Gmail search query (e.g. 'from:alice label:unread')"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of messages to return"),
  labelIds: z.array(z.string()).optional().describe("Filter by label IDs"),
  pageToken: z.string().optional().describe("Pagination token"),
});

export const gmailSearchOutputSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      threadId: z.string(),
      snippet: z.string(),
      from: z.string().optional(),
      to: z.array(z.string()).optional(),
      subject: z.string().optional(),
      date: z.string().optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
});

export const gmailReadInputSchema = z.object({
  messageId: z.string().min(1).describe("Unique Gmail message identifier"),
});

export const gmailReadOutputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string(),
  from: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  date: z.string().optional(),
  bodyText: z.string(),
  labels: z.array(z.string()),
});

export const gmailSummarizeInputSchema = z.object({
  threadId: z.string().min(1).describe("Unique Gmail thread identifier"),
});

export const gmailSummarizeOutputSchema = z.object({
  id: z.string(),
  subject: z.string(),
  messageCount: z.number(),
  participants: z.array(z.string()),
  summary: z.string().optional(),
});

export const gmailDraftInputSchema = z.object({
  to: z.array(z.string().email()).min(1).describe("Email recipients"),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).describe("Message subject"),
  body: z.string().min(1).describe("Message body text"),
  threadId: z.string().optional().describe("Existing thread ID if replying"),
});

export const gmailDraftOutputSchema = z.object({
  id: z.string(),
  messageId: z.string(),
});

export const gmailSendInputSchema = gmailDraftInputSchema;

export const gmailSendOutputSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});

// ==========================================
// CALENDAR SCHEMAS
// ==========================================

export const calendarListEventsInputSchema = z.object({
  calendarId: z.string().default("primary").describe("Calendar ID ('primary' by default)"),
  timeMin: z.string().optional().describe("Lower time bound in ISO 8601 format"),
  timeMax: z.string().optional().describe("Upper time bound in ISO 8601 format"),
  query: z.string().optional().describe("Text query filter"),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export const calendarEventSchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()).optional(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
});

export const calendarListEventsOutputSchema = z.object({
  events: z.array(calendarEventSchema),
});

export const calendarGetEventInputSchema = z.object({
  calendarId: z.string().default("primary"),
  eventId: z.string().min(1),
});

export const calendarAvailabilityInputSchema = z.object({
  calendarId: z.string().default("primary"),
  timeMin: z.string().describe("Start of time period in ISO 8601 format"),
  timeMax: z.string().describe("End of time period in ISO 8601 format"),
});

export const calendarAvailabilityOutputSchema = z.object({
  calendarId: z.string(),
  timeMin: z.string(),
  timeMax: z.string(),
  busySlots: z.array(z.object({ start: z.string(), end: z.string() })),
  freeSlots: z.array(z.object({ start: z.string(), end: z.string() })),
});

export const calendarCreateEventInputSchema = z.object({
  calendarId: z.string().default("primary"),
  summary: z.string().min(1).describe("Event title"),
  description: z.string().optional(),
  start: z.string().describe("Start date and time in ISO 8601 format"),
  end: z.string().describe("End date and time in ISO 8601 format"),
  attendees: z.array(z.string().email()).optional().describe("Attendee email addresses"),
  location: z.string().optional(),
});

export const calendarUpdateEventInputSchema = z.object({
  calendarId: z.string().default("primary"),
  eventId: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  attendees: z.array(z.string().email()).optional(),
  location: z.string().optional(),
});

export const calendarDeleteEventInputSchema = z.object({
  calendarId: z.string().default("primary"),
  eventId: z.string().min(1),
});

export const calendarDeleteEventOutputSchema = z.object({
  success: z.boolean(),
  eventId: z.string(),
});

/**
 * Creates the official Google Workspace tools collection (Gmail & Calendar) for NEXUS.
 */
export function createGoogleWorkspaceTools(options: {
  client: GoogleWorkspaceClient;
}): ToolDefinition<never, unknown>[] {
  const { client } = options;

  const tools = [
    // 1. gmail.search
    {
      name: "gmail.search",
      version: "1.0.0",
      description: "Searches emails in user's Gmail mailbox by keywords or labels.",
      inputSchema: gmailSearchInputSchema,
      outputSchema: gmailSearchOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["email.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof gmailSearchInputSchema>) => `Search emails: ${input.query}`,
      execute: async (input: z.infer<typeof gmailSearchInputSchema>, context: ToolContext) => {
        return client.searchEmails(input, context.signal);
      },
    },

    // 2. gmail.read
    {
      name: "gmail.read",
      version: "1.0.0",
      description:
        "Reads full content of an email. Returned text is encapsulated in prompt-injection defense tags.",
      inputSchema: gmailReadInputSchema,
      outputSchema: gmailReadOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["email.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof gmailReadInputSchema>) => `Read email ${input.messageId}`,
      execute: async (input: z.infer<typeof gmailReadInputSchema>, context: ToolContext) => {
        return client.getEmail(input, context.signal);
      },
    },

    // 3. gmail.summarize
    {
      name: "gmail.summarize",
      version: "1.0.0",
      description: "Provides chronological thread history and summary for a Gmail thread.",
      inputSchema: gmailSummarizeInputSchema,
      outputSchema: gmailSummarizeOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["email.read"],
      requiresConfirmation: false,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof gmailSummarizeInputSchema>) =>
        `Summary of thread ${input.threadId}`,
      execute: async (input: z.infer<typeof gmailSummarizeInputSchema>, context: ToolContext) => {
        return client.getThread(input, context.signal);
      },
    },

    // 4. gmail.draft
    {
      name: "gmail.draft",
      version: "1.0.0",
      description: "Prepares a draft email in Gmail without sending.",
      inputSchema: gmailDraftInputSchema,
      outputSchema: gmailDraftOutputSchema,
      riskLevel: "MEDIUM",
      requiredPermissions: ["email.send"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof gmailDraftInputSchema>) =>
        `Prepare draft for ${input.to.join(", ")} ("${input.subject}")`,
      execute: async (input: z.infer<typeof gmailDraftInputSchema>, context: ToolContext) => {
        return client.createDraft(
          {
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            bodyText: input.body,
            threadId: input.threadId,
          },
          context.signal,
        );
      },
    },

    // 5. gmail.send (MANDATORY CONFIRMATION)
    {
      name: "gmail.send",
      version: "1.0.0",
      description:
        "Sends an email from the user's Gmail account. Requires explicit human confirmation before sending.",
      inputSchema: gmailSendInputSchema,
      outputSchema: gmailSendOutputSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["email.send"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof gmailSendInputSchema>) =>
        `Send email to ${input.to.join(", ")} with subject "${input.subject}"`,
      execute: async (input: z.infer<typeof gmailSendInputSchema>, context: ToolContext) => {
        return client.sendEmail(
          {
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            bodyText: input.body,
            threadId: input.threadId,
          },
          context.signal,
        );
      },
    },

    // 6. calendar.list_events
    {
      name: "calendar.list_events",
      version: "1.0.0",
      description: "Lists events from Google Calendar.",
      inputSchema: calendarListEventsInputSchema,
      outputSchema: calendarListEventsOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["calendar.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof calendarListEventsInputSchema>) =>
        `View calendar ${input.calendarId ?? "primary"}`,
      execute: async (
        input: z.infer<typeof calendarListEventsInputSchema>,
        context: ToolContext,
      ) => {
        const events = await client.listEvents(input, context.signal);
        return { events };
      },
    },

    // 7. calendar.get_event
    {
      name: "calendar.get_event",
      version: "1.0.0",
      description: "Gets details for a specific calendar event.",
      inputSchema: calendarGetEventInputSchema,
      outputSchema: calendarEventSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["calendar.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof calendarGetEventInputSchema>) =>
        `View event ${input.eventId}`,
      execute: async (input: z.infer<typeof calendarGetEventInputSchema>, context: ToolContext) => {
        return client.getEvent(input, context.signal);
      },
    },

    // 8. calendar.check_availability
    {
      name: "calendar.check_availability",
      version: "1.0.0",
      description: "Analyzes busy and free slots over a given time range.",
      inputSchema: calendarAvailabilityInputSchema,
      outputSchema: calendarAvailabilityOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["calendar.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof calendarAvailabilityInputSchema>) =>
        `Check availability from ${input.timeMin} to ${input.timeMax}`,
      execute: async (
        input: z.infer<typeof calendarAvailabilityInputSchema>,
        context: ToolContext,
      ) => {
        return client.checkAvailability(input, context.signal);
      },
    },

    // 9. calendar.create_event (MANDATORY CONFIRMATION)
    {
      name: "calendar.create_event",
      version: "1.0.0",
      description:
        "Creates a new event in Google Calendar. Requires explicit human confirmation before creation.",
      inputSchema: calendarCreateEventInputSchema,
      outputSchema: calendarEventSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["calendar.write"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof calendarCreateEventInputSchema>) =>
        `Create event "${input.summary}" on ${input.start}`,
      execute: async (
        input: z.infer<typeof calendarCreateEventInputSchema>,
        context: ToolContext,
      ) => {
        return client.createEvent(input, context.signal);
      },
    },

    // 10. calendar.update_event (MANDATORY CONFIRMATION)
    {
      name: "calendar.update_event",
      version: "1.0.0",
      description:
        "Updates an existing event in Google Calendar. Requires explicit human confirmation.",
      inputSchema: calendarUpdateEventInputSchema,
      outputSchema: calendarEventSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["calendar.write"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof calendarUpdateEventInputSchema>) =>
        `Update event ${input.eventId} ("${input.summary ?? "modifications"}")`,
      execute: async (
        input: z.infer<typeof calendarUpdateEventInputSchema>,
        context: ToolContext,
      ) => {
        return client.updateEvent(input, context.signal);
      },
    },

    // 11. calendar.delete_event (MANDATORY CONFIRMATION)
    {
      name: "calendar.delete_event",
      version: "1.0.0",
      description:
        "Permanently deletes an event from Google Calendar. Requires explicit human confirmation.",
      inputSchema: calendarDeleteEventInputSchema,
      outputSchema: calendarDeleteEventOutputSchema,
      riskLevel: "CRITICAL",
      requiredPermissions: ["calendar.write"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof calendarDeleteEventInputSchema>) =>
        `Permanently delete event ${input.eventId} from calendar ${input.calendarId}`,
      execute: async (
        input: z.infer<typeof calendarDeleteEventInputSchema>,
        context: ToolContext,
      ) => {
        return client.deleteEvent(input, context.signal);
      },
    },
  ];

  return tools as unknown as ToolDefinition<never, unknown>[];
}
