import { describe, expect, it, vi } from "vitest";
import { createGoogleWorkspaceTools } from "../src/tools.js";
import type { GoogleWorkspaceClient } from "../src/client.js";
import type { ToolContext, ToolDefinition } from "@nexus/tools";

describe("Google Workspace Tools (Gmail & Calendar)", () => {
  const createMockContext = (): ToolContext => ({
    runId: "run-test-1",
    userId: "user-1",
    conversationId: "conv-1",
    correlationId: "corr-1",
    signal: new AbortController().signal,
    idempotencyKey: "idem-1",
    attempt: 1,
    onProgress: vi.fn(),
  });

  const mockClient: Partial<GoogleWorkspaceClient> = {
    searchEmails: vi.fn().mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1", snippet: "hello", subject: "Subject 1" }],
    }),
    getEmail: vi.fn().mockResolvedValue({
      id: "m1",
      threadId: "t1",
      snippet: "hello",
      subject: "Subject 1",
      bodyText: "Message",
      labels: ["INBOX"],
    }),
    getThread: vi.fn().mockResolvedValue({
      id: "t1",
      subject: "Thread 1",
      messageCount: 2,
      participants: ["alice@example.com"],
      summary: "Thread summary",
      messages: [],
    }),
    createDraft: vi.fn().mockResolvedValue({ id: "draft-1", messageId: "msg-draft-1" }),
    sendEmail: vi.fn().mockResolvedValue({ id: "sent-1", threadId: "t1" }),
    listEvents: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn().mockResolvedValue({
      id: "e1",
      calendarId: "primary",
      summary: "Event",
      start: "2026-10-21T10:00:00Z",
      end: "2026-10-21T11:00:00Z",
    }),
    checkAvailability: vi.fn().mockResolvedValue({
      calendarId: "primary",
      timeMin: "2026-10-21T00:00:00Z",
      timeMax: "2026-10-21T23:59:59Z",
      busySlots: [],
      freeSlots: [],
    }),
    createEvent: vi.fn().mockResolvedValue({
      id: "new-e1",
      calendarId: "primary",
      summary: "New event",
      start: "2026-10-21T14:00:00Z",
      end: "2026-10-21T15:00:00Z",
    }),
    updateEvent: vi.fn().mockResolvedValue({
      id: "e1",
      calendarId: "primary",
      summary: "Updated event",
      start: "2026-10-21T14:00:00Z",
      end: "2026-10-21T15:00:00Z",
    }),
    deleteEvent: vi.fn().mockResolvedValue({ success: true, eventId: "e1" }),
  };

  const tools = createGoogleWorkspaceTools({
    client: mockClient as unknown as GoogleWorkspaceClient,
  });

  it("registers all 11 tools with correct permissions and risk levels", () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain("gmail.search");
    expect(names).toContain("gmail.read");
    expect(names).toContain("gmail.summarize");
    expect(names).toContain("gmail.draft");
    expect(names).toContain("gmail.send");
    expect(names).toContain("calendar.list_events");
    expect(names).toContain("calendar.get_event");
    expect(names).toContain("calendar.check_availability");
    expect(names).toContain("calendar.create_event");
    expect(names).toContain("calendar.update_event");
    expect(names).toContain("calendar.delete_event");
    expect(tools).toHaveLength(11);
  });

  it("strictly requires human confirmation for mutating send and edit actions", () => {
    const sendTool = tools.find((t) => t.name === "gmail.send")!;
    expect(sendTool.requiresConfirmation).toBe(true);
    expect(sendTool.riskLevel).toBe("HIGH");
    expect(sendTool.requiredPermissions).toEqual(["email.send"]);

    const createEventTool = tools.find((t) => t.name === "calendar.create_event")!;
    expect(createEventTool.requiresConfirmation).toBe(true);
    expect(createEventTool.riskLevel).toBe("HIGH");
    expect(createEventTool.requiredPermissions).toEqual(["calendar.write"]);

    const updateEventTool = tools.find((t) => t.name === "calendar.update_event")!;
    expect(updateEventTool.requiresConfirmation).toBe(true);
    expect(updateEventTool.riskLevel).toBe("HIGH");

    const deleteEventTool = tools.find((t) => t.name === "calendar.delete_event")!;
    expect(deleteEventTool.requiresConfirmation).toBe(true);
    expect(deleteEventTool.riskLevel).toBe("CRITICAL");
  });

  it("allows read operations and draft creation without blocking confirmation", () => {
    const searchTool = tools.find((t) => t.name === "gmail.search")!;
    expect(searchTool.requiresConfirmation).toBe(false);
    expect(searchTool.riskLevel).toBe("SAFE");

    const readTool = tools.find((t) => t.name === "gmail.read")!;
    expect(readTool.requiresConfirmation).toBe(false);

    const draftTool = tools.find((t) => t.name === "gmail.draft")!;
    expect(draftTool.requiresConfirmation).toBe(false);
    expect(draftTool.riskLevel).toBe("MEDIUM");

    const listEventsTool = tools.find((t) => t.name === "calendar.list_events")!;
    expect(listEventsTool.requiresConfirmation).toBe(false);
  });

  it("executes gmail.send and generates clear confirmation summary", async () => {
    const rawTool = tools.find((t) => t.name === "gmail.send")!;
    const sendTool = rawTool as unknown as ToolDefinition<
      { to: string[]; subject: string; body: string },
      { id: string; threadId: string }
    >;
    const input = {
      to: ["colleague@example.com"],
      subject: "Project Report",
      body: "Here is the report.",
    };

    const summary = sendTool.summarize?.(input);
    expect(summary).toBe('Send email to colleague@example.com with subject "Project Report"');

    const ctx = createMockContext();
    const result = await sendTool.execute(input, ctx);
    expect(result).toEqual({ id: "sent-1", threadId: "t1" });
    expect(mockClient.sendEmail).toHaveBeenCalled();
  });
});
