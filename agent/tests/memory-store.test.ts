import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../src/edgeone/memory-store";

describe("MemoryConversationStore", () => {
  it("supports the local history lifecycle and user isolation", async () => {
    const store = new MemoryConversationStore();
    await store.appendMessage({
      conversationId: "user-a:conv-a",
      role: "user",
      content: "问题",
      userId: "user-a",
    });
    await store.updateConversation({
      conversationId: "user-a:conv-a",
      metadata: { kind: "rag-chat", title: "问题" },
    });
    await store.appendMessage({
      conversationId: "user-a:conv-a",
      role: "assistant",
      content: "回答",
      userId: "user-a",
    });

    expect((await store.listConversations({ userId: "user-a" })).items)
      .toHaveLength(1);
    expect((await store.listConversations({ userId: "user-b" })).items)
      .toHaveLength(0);
    expect(await store.getMessages({
      conversationId: "user-a:conv-a",
      order: "desc",
      limit: 1,
    })).toMatchObject([{ role: "assistant", content: "回答" }]);

    const [assistant] = await store.getMessages({
      conversationId: "user-a:conv-a",
      order: "desc",
      limit: 1,
    });
    await store.updateMessage({
      conversationId: "user-a:conv-a",
      messageId: assistant!.messageId!,
      content: "修订回答",
    });
    expect(await store.getMessages({
      conversationId: "user-a:conv-a",
      order: "desc",
      limit: 1,
    })).toMatchObject([{ content: "修订回答" }]);

    await store.deleteConversation({ conversationId: "user-a:conv-a" });
    expect(await store.getMessages({ conversationId: "user-a:conv-a" }))
      .toEqual([]);
  });
});
