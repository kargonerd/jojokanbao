import type {
  EdgeOneConversationList,
  EdgeOneConversationMeta,
  EdgeOneConversationStore,
  EdgeOneStoredMessage,
} from "./types";

type StoredConversation = EdgeOneConversationMeta & { userId?: string };

/** Process-local Store used only by the development Agent server. */
export class MemoryConversationStore implements EdgeOneConversationStore {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messages = new Map<string, EdgeOneStoredMessage[]>();
  private nextMessageId = 1;

  async getMessages(input: {
    conversationId: string;
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<EdgeOneStoredMessage[]> {
    const stored = [...(this.messages.get(input.conversationId) ?? [])];
    if (input.order === "desc") stored.reverse();
    return stored.slice(0, input.limit ?? stored.length);
  }

  async appendMessage(input: {
    conversationId: string;
    role: "user" | "assistant" | "system" | "tool";
    content: unknown;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const now = Date.now();
    const messageId = `local-${this.nextMessageId++}`;
    const messages = this.messages.get(input.conversationId) ?? [];
    messages.push({
      messageId,
      role: input.role,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    this.messages.set(input.conversationId, messages);

    const current = this.conversations.get(input.conversationId);
    this.conversations.set(input.conversationId, {
      conversationId: input.conversationId,
      createdAt: current?.createdAt ?? now,
      lastMessageAt: now,
      messageCount: messages.length,
      ...(current?.metadata ? { metadata: current.metadata } : {}),
      ...(input.userId || current?.userId
        ? { userId: input.userId ?? current?.userId }
        : {}),
    });
    return messageId;
  }

  async updateMessage(input: {
    conversationId: string;
    messageId: string;
    content?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<EdgeOneStoredMessage> {
    const messages = this.messages.get(input.conversationId) ?? [];
    const index = messages.findIndex((message) => message.messageId === input.messageId);
    if (index < 0) throw new Error("Message not found");
    const current = messages[index]!;
    const updated: EdgeOneStoredMessage = {
      ...current,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: Date.now(),
    };
    messages[index] = updated;
    return updated;
  }

  async getConversation(input: {
    conversationId: string;
  }): Promise<EdgeOneConversationMeta> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }

  async listConversations(input: {
    limit?: number;
    order?: "asc" | "desc";
    after?: string;
    before?: string;
    userId?: string;
  }): Promise<EdgeOneConversationList> {
    const items = [...this.conversations.values()]
      .filter((conversation) => !input.userId || conversation.userId === input.userId)
      .sort((left, right) => left.lastMessageAt - right.lastMessageAt);
    if (input.order !== "asc") items.reverse();
    return { items: items.slice(0, input.limit ?? items.length) };
  }

  async updateConversation(input: {
    conversationId: string;
    metadata: Record<string, unknown>;
  }): Promise<EdgeOneConversationMeta> {
    const now = Date.now();
    const current = this.conversations.get(input.conversationId);
    const next: StoredConversation = {
      conversationId: input.conversationId,
      createdAt: current?.createdAt ?? now,
      lastMessageAt: current?.lastMessageAt ?? now,
      messageCount: current?.messageCount ?? 0,
      metadata: { ...current?.metadata, ...input.metadata },
      ...(current?.userId ? { userId: current.userId } : {}),
    };
    this.conversations.set(input.conversationId, next);
    return next;
  }

  async deleteConversation(input: { conversationId: string }): Promise<void> {
    this.conversations.delete(input.conversationId);
    this.messages.delete(input.conversationId);
  }
}
