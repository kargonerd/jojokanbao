import { describe, expect, it, vi } from "vitest";
import {
  AgentHttpError,
  createConversationAdminHandler,
  type EdgeOneConversationStore,
  type EdgeOneStoredMessage,
} from "../src";

function request(pathname: string, method = "GET") {
  return new Request(`https://agent.example${pathname}`, {
    method,
    headers: { Authorization: "Bearer user-token" },
  });
}

function baseStore(): EdgeOneConversationStore {
  return {
    getMessages: vi.fn(async () => []),
    appendMessage: vi.fn(async () => "message-1"),
  };
}

describe("createConversationAdminHandler", () => {
  const authorize = async () => ({ id: "user-1" });

  it("lists only the signed-in user's RAG conversations", async () => {
    const store: EdgeOneConversationStore = {
      ...baseStore(),
      listConversations: vi.fn(async () => ({
        items: [
          {
            conversationId: "user-1:conv_first",
            createdAt: 100,
            lastMessageAt: 200,
            messageCount: 2,
            metadata: {
              kind: "rag-chat",
              title: "劳动价值是什么",
              scope: { mode: "all", datasetIds: ["book-a"] },
            },
          },
          {
            conversationId: "user-1:credential:openai-codex",
            createdAt: 80,
            lastMessageAt: 90,
            messageCount: 1,
            metadata: { kind: "credential" },
          },
          {
            conversationId: "user-2:conv_hidden",
            createdAt: 70,
            lastMessageAt: 80,
            messageCount: 2,
            metadata: { kind: "rag-chat", title: "不能看到" },
          },
        ],
        nextCursor: "next-page",
      })),
    };
    const handle = createConversationAdminHandler({ authorize });

    const response = await handle({
      agent: { store },
      request: request("/gateway/conversations?limit=20"),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: [{
        id: "conv_first",
        title: "劳动价值是什么",
        createdAt: 100,
        lastMessageAt: 200,
        messageCount: 2,
        scope: { mode: "all", datasetIds: ["book-a"] },
      }],
      nextCursor: "next-page",
    });
    expect(store.listConversations).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 20,
      order: "desc",
    });
  });

  it("restores messages and their persisted citation locations", async () => {
    const store: EdgeOneConversationStore = {
      ...baseStore(),
      getMessages: vi.fn(async (): Promise<EdgeOneStoredMessage[]> => [
        {
          messageId: "message-user",
          role: "user",
          content: "什么是劳动价值？",
          createdAt: 100,
        },
        {
          messageId: "message-assistant",
          role: "assistant",
          content: "回答正文",
          createdAt: 120,
          metadata: {
            references: [{
              citationId: "Jchapter2",
              datasetId: "book-a",
              datasetTitle: "甲书",
              itemId: "book-a:item-a",
              itemTitle: "甲书 第一卷",
              targetId: "chapter:2",
              title: "第二章",
              excerpt: "劳动创造价值",
              fragmentObject: "content/book-a/chapter-2.jox",
            }],
          },
        },
      ]),
      getConversation: vi.fn(async () => ({
        conversationId: "user-1:conv_first",
        createdAt: 100,
        lastMessageAt: 120,
        messageCount: 2,
        metadata: {
          kind: "rag-chat",
          title: "什么是劳动价值？",
          scope: { datasetIds: ["book-a"] },
        },
      })),
    };
    const handle = createConversationAdminHandler({ authorize });

    const response = await handle({
      agent: { store },
      request: request("/gateway/conversations/conv_first"),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversation: {
        id: "conv_first",
        title: "什么是劳动价值？",
        scope: { datasetIds: ["book-a"] },
      },
      messages: [
        { id: "message-user", role: "user", content: "什么是劳动价值？" },
        {
          id: "message-assistant",
          role: "assistant",
          references: [{
            citationId: "Jchapter2",
            datasetId: "book-a",
            datasetTitle: "甲书",
            itemId: "book-a:item-a",
            itemTitle: "甲书 第一卷",
            targetId: "chapter:2",
            title: "第二章",
            excerpt: "劳动创造价值",
            fragmentObject: "content/book-a/chapter-2.jox",
          }],
        },
      ],
    });
    expect(store.getMessages).toHaveBeenCalledWith({
      conversationId: "user-1:conv_first",
      limit: 100,
      order: "asc",
    });
  });

  it("deletes only the user-prefixed storage conversation", async () => {
    const deleteConversation = vi.fn(async () => undefined);
    const handle = createConversationAdminHandler({ authorize });
    const response = await handle({
      agent: { store: { ...baseStore(), deleteConversation } },
      request: request("/gateway/conversations/conv_first", "DELETE"),
    });

    expect(response.status).toBe(204);
    expect(deleteConversation).toHaveBeenCalledWith({
      conversationId: "user-1:conv_first",
    });
  });

  it("rejects unauthenticated requests before touching storage", async () => {
    const getMessages = vi.fn(async () => []);
    const handle = createConversationAdminHandler({
      authorize: async () => {
        throw new AgentHttpError(401, "Authentication required");
      },
    });
    const response = await handle({
      agent: { store: { ...baseStore(), getMessages } },
      request: request("/gateway/conversations/conv_first"),
    });

    expect(response.status).toBe(401);
    expect(getMessages).not.toHaveBeenCalled();
  });
});
