import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createEdgeOneAgentHandler,
  type EdgeOneTracer,
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
    const updateConversation = vi.fn(async (input: {
      conversationId: string;
      metadata: Record<string, unknown>;
    }) => ({
      conversationId: input.conversationId,
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 1,
      metadata: input.metadata,
    }));
    const appendMessage = vi.fn(async (input: {
      role: EdgeOneStoredMessage["role"];
      content: unknown;
    }) => {
      messages.push({ role: input.role, content: input.content });
      return `msg-${messages.length}`;
    });
    const handle = createEdgeOneAgentHandler({
      authorize: async () => ({ id: "user-1" }),
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
          message: "你好",
          scope: {
            mode: "selected",
            datasetIds: [" book-a "],
            itemIds: ["book-a:item-a"],
            manifestObjects: ["content/book-a/manifest.jox"],
          },
        },
      },
      store: {
        getMessages,
        appendMessage,
        updateConversation,
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
        metadata: {
          scope: {
            mode: "selected",
            datasetIds: ["book-a"],
            itemIds: ["book-a:item-a"],
            manifestObjects: ["content/book-a/manifest.jox"],
          },
        },
      }),
    );
    expect(updateConversation).toHaveBeenCalledWith({
      conversationId: "user-1:conversation-1",
      metadata: {
        kind: "rag-chat",
        title: "你好",
        scope: {
          mode: "selected",
          datasetIds: ["book-a"],
          itemIds: ["book-a:item-a"],
          manifestObjects: ["content/book-a/manifest.jox"],
        },
      },
    });
    expect(messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，JOJO。" },
    ]);
  });

  it("does not initialize a model for unauthenticated requests", async () => {
    const createModelRuntime = vi.fn();
    const handle = createEdgeOneAgentHandler({
      authorize: async () => {
        throw new (await import("../src")).AgentHttpError(401, "Authentication required");
      },
      createModelRuntime,
    });

    const response = await handle({
      request: { body: { message: "Hello" } },
    });

    expect(response.status).toBe(401);
    expect(createModelRuntime).not.toHaveBeenCalled();
  });

  it("uses client-supplied history without reading or writing conversation Store", async () => {
    const faux = fauxProvider({
      provider: "openai-codex",
      tokensPerSecond: 100_000,
    });
    faux.setResponses([fauxAssistantMessage("接着上一轮回答。")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const getMessages = vi.fn(async () => []);
    const appendMessage = vi.fn(async () => "message-id");
    const updateConversation = vi.fn();
    const handle = createEdgeOneAgentHandler({
      authorize: async () => ({ id: "user-1" }),
      createModelRuntime: async () => ({
        config: { provider: "openai-codex", model: model.id },
        models,
        model,
        configured: true,
      }),
    });

    const response = await handle({
      conversation_id: "conversation-client",
      request: {
        body: {
          message: "继续说",
          historyMode: "client",
          history: [
            { role: "user", content: "上一问" },
            { role: "assistant", content: "上一答" },
          ],
        },
      },
      store: { getMessages, appendMessage, updateConversation },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("接着上一轮回答。");
    expect(getMessages).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it("manually traces the custom Pi Agent run and each tool call", async () => {
    const faux = fauxProvider({
      provider: "openai-codex",
      tokensPerSecond: 100_000,
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { query: "剩余价值" })),
      fauxAssistantMessage("已找到原文。"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const parameters = Type.Object({ query: Type.String() });
    const tool: AgentTool<typeof parameters> = {
      name: "lookup",
      label: "Lookup",
      description: "Lookup a phrase",
      parameters,
      execute: async (_callId, args) => ({
        content: [{ type: "text", text: args.query }],
        details: { total: 1, strategy: "memory" },
      }),
    };
    const spans: Array<{
      name: string;
      initial?: Record<string, string | number | boolean>;
      appended: Array<Record<string, string | number | boolean>>;
    }> = [];
    const span: NonNullable<EdgeOneTracer["span"]> = async <T>(
      name: string,
      callback: Parameters<NonNullable<EdgeOneTracer["span"]>>[1],
      initial?: Record<string, string | number | boolean>,
    ): Promise<T> => {
      const record = { name, initial, appended: [] as Array<Record<string, string | number | boolean>> };
      spans.push(record);
      return callback({ setAttributes: (attributes) => record.appended.push(attributes) }) as Promise<T>;
    };
    const handle = createEdgeOneAgentHandler({
      authorize: async () => ({ id: "user-1" }),
      tools: async () => [tool],
      createModelRuntime: async () => ({
        config: { provider: "openai-codex", model: model.id },
        models,
        model,
        configured: true,
      }),
    });

    const response = await handle({
      conversation_id: "conversation-traced",
      request: { body: { message: "查一下剩余价值" } },
      tracer: { span },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("已找到原文。");
    expect(spans.map((entry) => entry.name)).toEqual([
      "jojo.rag_agent",
      "jojo.tool.lookup",
    ]);
    expect(spans[0]?.initial).toMatchObject({
      "openinference.span.kind": "AGENT",
      "agent.conversation_id": "conversation-traced",
    });
    expect(spans[0]?.appended).toEqual(expect.arrayContaining([
      expect.objectContaining({ "agent.status": "ok", "agent.tool_calls": 1 }),
    ]));
    expect(spans[1]?.initial).toMatchObject({
      "openinference.span.kind": "TOOL",
      "tool.name": "lookup",
    });
    expect(spans[1]?.appended).toEqual(expect.arrayContaining([
      expect.objectContaining({ "tool.status": "ok" }),
    ]));
  });

  it("rejects an invalid request before user auth or model initialization", async () => {
    const authorize = vi.fn(async () => ({ id: "user-1" }));
    const createModelRuntime = vi.fn();
    const handle = createEdgeOneAgentHandler({
      authorize,
      createModelRuntime,
    });

    const response = await handle({
      conversation_id: "conversation-1",
      request: {
        method: "POST",
        body: {},
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "message is required",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(createModelRuntime).not.toHaveBeenCalled();
  });
});
