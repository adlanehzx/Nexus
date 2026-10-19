import type { PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import {
  NotFoundError,
  type Conversation,
  type ConversationStore,
  type Message,
  type Page,
  type PageRequest,
} from "../stores.js";

type StoredRole = "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";

/** Persistance durable des conversations et de leur transcript. */
export class PrismaConversationStore implements ConversationStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async create(input: { userId: string; title: string }): Promise<Conversation> {
    return presentConversation(
      await this.#prisma.conversation.create({
        data: { id: uuidv7(), userId: input.userId, title: input.title },
      }),
    );
  }

  async get(id: string): Promise<Conversation | undefined> {
    const record = await this.#prisma.conversation.findUnique({ where: { id } });
    return record === null ? undefined : presentConversation(record);
  }

  async listByUser(userId: string, page: PageRequest): Promise<Page<Conversation>> {
    const where = { userId };
    const [records, total] = await Promise.all([
      this.#prisma.conversation.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: page.limit + 1,
        ...(page.cursor === undefined ? {} : { cursor: { id: page.cursor }, skip: 1 }),
      }),
      this.#prisma.conversation.count({ where }),
    ]);
    const hasMore = records.length > page.limit;
    const items = records.slice(0, page.limit).map(presentConversation);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      total,
    };
  }

  async archive(id: string): Promise<Conversation> {
    const existing = await this.#prisma.conversation.findUnique({ where: { id } });
    if (existing === null) throw new NotFoundError("Conversation", id);
    return presentConversation(
      await this.#prisma.conversation.update({
        where: { id },
        data: { status: "ARCHIVED" },
      }),
    );
  }

  async appendMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const existing = await this.#prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { id: true },
    });
    if (existing === null) throw new NotFoundError("Conversation", input.conversationId);

    const createdAt = new Date();
    const record = await this.#prisma.$transaction(async (transaction) => {
      const message = await transaction.message.create({
        data: {
          id: uuidv7(),
          conversationId: input.conversationId,
          role: input.role.toUpperCase() as StoredRole,
          content: [{ type: "text", text: input.content }],
          contentText: input.content,
          originClientDeviceId: input.originClientDeviceId,
          createdAt,
        },
      });
      await transaction.conversation.update({
        where: { id: input.conversationId },
        data: { lastMessageAt: createdAt },
      });
      return message;
    });

    return presentMessage(record);
  }

  async listMessages(conversationId: string, page: PageRequest): Promise<Page<Message>> {
    const where = { conversationId };
    const [records, total] = await Promise.all([
      this.#prisma.message.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: page.limit + 1,
        ...(page.cursor === undefined ? {} : { cursor: { id: page.cursor }, skip: 1 }),
      }),
      this.#prisma.message.count({ where }),
    ]);
    const hasMore = records.length > page.limit;
    const items = records.slice(0, page.limit).map(presentMessage);
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      total,
    };
  }
}

function presentConversation(record: {
  id: string;
  userId: string;
  title: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Conversation {
  if (record.status !== "ACTIVE" && record.status !== "ARCHIVED") {
    throw new Error(`Invalid conversation status: ${record.status}`);
  }
  return { ...record, title: record.title ?? "", status: record.status };
}

function presentMessage(record: {
  id: string;
  conversationId: string;
  role: string;
  contentText: string;
  originClientDeviceId: string | null;
  createdAt: Date;
}): Message {
  const role = record.role.toLowerCase();
  if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
    throw new Error(`Invalid message role: ${record.role}`);
  }
  return {
    id: record.id,
    conversationId: record.conversationId,
    role,
    content: record.contentText,
    originClientDeviceId: record.originClientDeviceId,
    createdAt: record.createdAt,
  };
}
