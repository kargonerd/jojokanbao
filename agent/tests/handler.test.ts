import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createEdgeOneAgentHandler,
  type EdgeOneStoredMessage,
} from "../src";

describe("createEdgeOneAgentHandler", () => {
  it("streams a real Pi Agent run and persists the conversation", async () => {
    const faux = fauxProvider({
      provider: "openai-codex",
      tokensPerSecond: 100_000,
    });
    faux.setResponses([fauxAssistantMessage("你好，JOJO。")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const messages: EdgeOneStoredMessage[] = [];
    const getMessages = vi.fn(async () => []);
    const appendMessage = vi.fn(async (input: {
      role: EdgeOneStoredMessage["role"];
      content: unknown;
    }) => {
      messages.push({ role: input.role, content: input.content });
      return `msg-${messages.length}`;
    });
    const handle = createEdgeOneAgentHandler({
      authorizeService: async () => undefined,
      createModelRuntime: async () => ({
        config: {
          provider: "openai-codex",
          model: model.id,
        },
        models,
        model,
        configured: true,
      }),
    });

    const response = await handle({
      conversation_id: "conversation-1",
      request: {
        body: {
          application: "test",
          userId: "user-1",
          message: "你好",
        },
      },
      store: {
        getMessages,
        appendMessage,
      },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: text_delta");
    expect(body).toContain("你好，JOJO。");
    expect(body).toContain("event: usage");
    expect(body).toContain("event: done");
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(getMessages).toHaveBeenCalledWith({
      conversationId: "user-1:conversation-1",
      limit: 20,
      order: "desc",
    });
    expect(appendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        conversationId: "user-1:conversation-1",
        userId: "user-1",
      }),
    );
    expect(messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，JOJO。" },
    ]);
  });

  it("does not initialize a model for unauthenticated requests", async () => {
    const createModelRuntime = vi.fn();
    const handle = createEdgeOneAgentHandler({
      authorizeService: async () => undefined,
      authorize: async () => {
        throw new (await import("../src")).AgentHttpError(401, "Authentication required");
      },
      createModelRuntime,
    });

    const response = await handle({
      request: {
        body: {
          application: "test",
          userId: "user-1",
          message: "Hello",
        },
      },
    });

    expect(response.status).toBe(401);
    expect(createModelRuntime).not.toHaveBeenCalled();
  });

  it("rejects direct requests before user auth or model initialization", async () => {
    const authorize = vi.fn(async () => ({ id: "user-1" }));
    const createModelRuntime = vi.fn();
    const handle = createEdgeOneAgentHandler({
      authorize,
      createModelRuntime,
    });

    const response = await handle({
      env: {
        JOJO_AGENT_SERVICE_SECRET: "0123456789abcdef0123456789abcdef",
      },
      conversation_id: "conversation-1",
      request: {
        method: "POST",
        body: {
          application: "test",
          userId: "user-1",
          message: "Hello",
        },
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Trusted service authentication required",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(createModelRuntime).not.toHaveBeenCalled();
  });
});
