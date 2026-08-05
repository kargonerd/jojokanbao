import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeAgentServiceRequest,
  createRemoteDocumentTools,
} from "../src";

const environment = {
  JOJO_AGENT_SERVICE_SECRET: "0123456789abcdef0123456789abcdef",
  JOJO_PLATFORM_API_URL: "https://jojokanbao.cn/api",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote RAG document tools", () => {
  it("calls the platform API with a service-signed document search", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          matches: [{ source_id: "source-1", start: 10, end: 20, text: "原文" }],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [search] = createRemoteDocumentTools({
      conversationId: "conversation-001",
      environment,
      notebookId: "notebook-1",
      sourceIds: ["source-1"],
      userId: "user-1",
    });
    if (!search) throw new Error("search tool is missing");

    const result = await search.execute(
      "call-1",
      { query: "王洪文", maxResults: 2 },
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://jojokanbao.cn/api/v1/internal/rag/documents",
    );
    const body = JSON.parse(String(init?.body)) as unknown;
    expect(body).toEqual({
      user_id: "user-1",
      notebook_id: "notebook-1",
      source_ids: ["source-1"],
      operation: "search",
      query: "王洪文",
      max_results: 2,
    });
    await expect(authorizeAgentServiceRequest({
      env: environment,
      conversation_id: "conversation-001",
      request: {
        method: "POST",
        headers: new Headers(init?.headers),
        body,
      },
    })).resolves.toBeUndefined();
  });
});
