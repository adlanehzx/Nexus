import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@nexus/tools";
import type { GoogleWorkspaceClient } from "./client.js";

// ==========================================
// SCHEMAS GMAIL
// ==========================================

export const gmailSearchInputSchema = z.object({
  query: z.string().min(1).describe("Requête de recherche Gmail (ex: 'from:alice label:unread')"),
  maxResults: z.number().int().min(1).max(50).optional().describe("Nombre maximal de messages à renvoyer"),
  labelIds: z.array(z.string()).optional().describe("Filtre par identifiants de libellés"),
  pageToken: z.string().optional().describe("Jeton de pagination"),
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
  messageId: z.string().min(1).describe("Identifiant unique du message Gmail"),
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
  threadId: z.string().min(1).describe("Identifiant unique du fil de discussion"),
});

export const gmailSummarizeOutputSchema = z.object({
  id: z.string(),
  subject: z.string(),
  messageCount: z.number(),
  participants: z.array(z.string()),
  summary: z.string().optional(),
});

export const gmailDraftInputSchema = z.object({
  to: z.array(z.string().email()).min(1).describe("Destinataires de l'email"),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).describe("Sujet du message"),
  body: z.string().min(1).describe("Corps textuel du message"),
  threadId: z.string().optional().describe("Identifiant de fil existant si réponse"),
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
// SCHEMAS CALENDAR
// ==========================================

export const calendarListEventsInputSchema = z.object({
  calendarId: z.string().default("primary").describe("Identifiant de l'agenda ('primary' par défaut)"),
  timeMin: z.string().optional().describe("Borne inférieure au format ISO 8601"),
  timeMax: z.string().optional().describe("Borne supérieure au format ISO 8601"),
  query: z.string().optional().describe("Filtre textuel"),
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
  timeMin: z.string().describe("Début de la période d'analyse ISO 8601"),
  timeMax: z.string().describe("Fin de la période d'analyse ISO 8601"),
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
  summary: z.string().min(1).describe("Titre de l'événement"),
  description: z.string().optional(),
  start: z.string().describe("Date et heure de début ISO 8601"),
  end: z.string().describe("Date et heure de fin ISO 8601"),
  attendees: z.array(z.string().email()).optional().describe("Emails des participants"),
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
 * Crée la collection d'outils officiels Google Workspace (Gmail et Calendar) pour NEXUS.
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
      description: "Recherche des emails dans la boîte Gmail de l'utilisateur par mots-clés ou libellés.",
      inputSchema: gmailSearchInputSchema,
      outputSchema: gmailSearchOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["email.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof gmailSearchInputSchema>) =>
        `Recherche d'emails : ${input.query}`,
      execute: async (input: z.infer<typeof gmailSearchInputSchema>, context: ToolContext) => {
        return client.searchEmails(input, context.signal);
      },
    },

    // 2. gmail.read
    {
      name: "gmail.read",
      version: "1.0.0",
      description:
        "Lit le contenu complet d'un email. Le texte renvoyé est encapsulé dans des balises de sécurité anti-injection.",
      inputSchema: gmailReadInputSchema,
      outputSchema: gmailReadOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["email.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof gmailReadInputSchema>) =>
        `Lecture de l'email ${input.messageId}`,
      execute: async (input: z.infer<typeof gmailReadInputSchema>, context: ToolContext) => {
        return client.getEmail(input, context.signal);
      },
    },

    // 3. gmail.summarize
    {
      name: "gmail.summarize",
      version: "1.0.0",
      description:
        "Fournit la chronologie ordonnée et le résumé des échanges d'un fil de discussion Gmail complet.",
      inputSchema: gmailSummarizeInputSchema,
      outputSchema: gmailSummarizeOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["email.read"],
      requiresConfirmation: false,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof gmailSummarizeInputSchema>) =>
        `Résumé du fil de discussion ${input.threadId}`,
      execute: async (input: z.infer<typeof gmailSummarizeInputSchema>, context: ToolContext) => {
        return client.getThread(input, context.signal);
      },
    },

    // 4. gmail.draft
    {
      name: "gmail.draft",
      version: "1.0.0",
      description:
        "Prépare un brouillon d'email dans la boîte Gmail sans l'expédier.",
      inputSchema: gmailDraftInputSchema,
      outputSchema: gmailDraftOutputSchema,
      riskLevel: "MEDIUM",
      requiredPermissions: ["email.send"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof gmailDraftInputSchema>) =>
        `Préparation du brouillon pour ${input.to.join(", ")} (« ${input.subject} »)`,
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

    // 5. gmail.send (CONFIRMATION OBLIGATOIRE)
    {
      name: "gmail.send",
      version: "1.0.0",
      description:
        "Envoie réellement un email depuis le compte Gmail de l'utilisateur. Requiert obligatoirement une confirmation humaine avant émission.",
      inputSchema: gmailSendInputSchema,
      outputSchema: gmailSendOutputSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["email.send"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof gmailSendInputSchema>) =>
        `Envoi d'un email à ${input.to.join(", ")} avec pour sujet « ${input.subject} »`,
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
      description: "Liste les événements de l'agenda Google Calendar.",
      inputSchema: calendarListEventsInputSchema,
      outputSchema: calendarListEventsOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["calendar.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof calendarListEventsInputSchema>) =>
        `Consultation de l'agenda ${input.calendarId ?? "primary"}`,
      execute: async (input: z.infer<typeof calendarListEventsInputSchema>, context: ToolContext) => {
        const events = await client.listEvents(input, context.signal);
        return { events };
      },
    },

    // 7. calendar.get_event
    {
      name: "calendar.get_event",
      version: "1.0.0",
      description: "Obtient le détail d'un événement spécifique du calendrier.",
      inputSchema: calendarGetEventInputSchema,
      outputSchema: calendarEventSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["calendar.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof calendarGetEventInputSchema>) =>
        `Consultation de l'événement ${input.eventId}`,
      execute: async (input: z.infer<typeof calendarGetEventInputSchema>, context: ToolContext) => {
        return client.getEvent(input, context.signal);
      },
    },

    // 8. calendar.check_availability
    {
      name: "calendar.check_availability",
      version: "1.0.0",
      description: "Analyse les créneaux libres et occupés sur une période donnée.",
      inputSchema: calendarAvailabilityInputSchema,
      outputSchema: calendarAvailabilityOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["calendar.read"],
      requiresConfirmation: false,
      timeoutMs: 20_000,
      summarize: (input: z.infer<typeof calendarAvailabilityInputSchema>) =>
        `Vérification des disponibilités du ${input.timeMin} au ${input.timeMax}`,
      execute: async (input: z.infer<typeof calendarAvailabilityInputSchema>, context: ToolContext) => {
        return client.checkAvailability(input, context.signal);
      },
    },

    // 9. calendar.create_event (CONFIRMATION OBLIGATOIRE)
    {
      name: "calendar.create_event",
      version: "1.0.0",
      description:
        "Crée un nouvel événement dans Google Calendar. Requiert obligatoirement une confirmation humaine avant création.",
      inputSchema: calendarCreateEventInputSchema,
      outputSchema: calendarEventSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["calendar.write"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof calendarCreateEventInputSchema>) =>
        `Création de l'événement « ${input.summary} » le ${input.start}`,
      execute: async (input: z.infer<typeof calendarCreateEventInputSchema>, context: ToolContext) => {
        return client.createEvent(input, context.signal);
      },
    },

    // 10. calendar.update_event (CONFIRMATION OBLIGATOIRE)
    {
      name: "calendar.update_event",
      version: "1.0.0",
      description:
        "Modifie un événement existant dans Google Calendar. Requiert obligatoirement une confirmation humaine.",
      inputSchema: calendarUpdateEventInputSchema,
      outputSchema: calendarEventSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["calendar.write"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof calendarUpdateEventInputSchema>) =>
        `Mise à jour de l'événement ${input.eventId} (« ${input.summary ?? "modifications"} »)`,
      execute: async (input: z.infer<typeof calendarUpdateEventInputSchema>, context: ToolContext) => {
        return client.updateEvent(input, context.signal);
      },
    },

    // 11. calendar.delete_event (CONFIRMATION OBLIGATOIRE)
    {
      name: "calendar.delete_event",
      version: "1.0.0",
      description:
        "Supprime définitivement un événement de Google Calendar. Requiert obligatoirement une confirmation humaine.",
      inputSchema: calendarDeleteEventInputSchema,
      outputSchema: calendarDeleteEventOutputSchema,
      riskLevel: "CRITICAL",
      requiredPermissions: ["calendar.write"],
      requiresConfirmation: true,
      timeoutMs: 30_000,
      summarize: (input: z.infer<typeof calendarDeleteEventInputSchema>) =>
        `Suppression définitive de l'événement ${input.eventId} du calendrier ${input.calendarId}`,
      execute: async (input: z.infer<typeof calendarDeleteEventInputSchema>, context: ToolContext) => {
        return client.deleteEvent(input, context.signal);
      },
    },
  ];

  return tools as unknown as ToolDefinition<never, unknown>[];
}
