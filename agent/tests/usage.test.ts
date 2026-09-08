import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { acquireAgentUsage } from "../src/edgeone/usage";
import { createEdgeOneAgentHandler } from "../src/edgeone/handler";
import type { EdgeOneAgentContext } from "../src/edgeone/types";
import * as agentRuntime from "../src/runtime";

const context: EdgeOneAgentContext = {
  env: { VITE_SUPABASE_URL: "https://test.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "public", JOJO_OPERATOR_TOKEN: "test-operator" },
  request: { body: { message: "hello" } },
};
const user = { id: "00000000-0000-4000-8000-000000000081" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("distributed AI usage", () => {
  it.each(["concurrent", "minute", "daily"])("rejects %s before initializing the model", async (reason) => {
    const fetcher = vi.fn(async () => Response.json({ allowed: false, reason, retryAfter: 42 }));
    vi.stubGlobal("fetch", fetcher);
    const createModelRuntime = vi.fn();
    const handle = createEdgeOneAgentHandler({ authorize: async () => user, createModelRuntime });
    const response = await handle(context);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toMatchObject({ code: `ai_${reason}_limit`, error: expect.any(String) });
    expect(createModelRuntime).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an uncertain reservation and releases its unique request", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(acquireAgentUsage(context, user)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
    expect(fetcher.mock.calls[1]![0]).toContain("release_agent_usage");
  });

  it("rejects malformed decisions without running unmetered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ allowed: true, maxRunSeconds: 0 })).mockResolvedValue(new Response(null, { status: 204 })));
    await expect(acquireAgentUsage(context, user)).rejects.toMatchObject({ status: 503 });
  });

  it("releases with a fresh signal after the request was aborted", async () => {
    const cancellation = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ allowed: true, maxRunSeconds: 300 })).mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const lease = await acquireAgentUsage({ ...context, request: { ...context.request, signal: cancellation.signal } }, user);
    cancellation.abort();
    await lease.release();
    expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(false);
  });

  it("releases when runtime initialization fails", async () => {
    const release = vi.fn(async () => {});
    const handle = createEdgeOneAgentHandler({
      authorize: async () => user,
      acquireUsage: async () => ({ maxRunSeconds: 300, release }),
      createModelRuntime: async () => { throw new Error("configuration unavailable"); },
    });
    expect((await handle(context)).status).toBe(503);
    expect(release).toHaveBeenCalledTimes(1);
  });

  const runtime = (answer = "hello") => {
    const faux = fauxProvider({ provider: "openai-codex", tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage(answer)]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    return { config: { provider: "openai-codex" as const, model: model.id }, models, model, configured: true };
  };

  it("releases before clients see the done frame", async () => {
    let releaseCompleted = false;
    const release = vi.fn(async () => { await Promise.resolve(); releaseCompleted = true; });
    const handle = createEdgeOneAgentHandler({
      authorize: async () => user,
      acquireUsage: async () => ({ maxRunSeconds: 300, release }),
      createModelRuntime: async () => runtime(),
    });
    const reader = (await handle(context)).body!.getReader();
    let sawDone = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (new TextDecoder().decode(chunk.value).includes("event: done")) {
        sawDone = true;
        expect(releaseCompleted).toBe(true);
      }
    }
    expect(sawDone).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("aborts model execution and releases when the response reader cancels", async () => {
    const release = vi.fn(async () => {});
    const handle = createEdgeOneAgentHandler({
      authorize: async () => user,
      acquireUsage: async () => ({ maxRunSeconds: 300, release }),
      createModelRuntime: async () => runtime("response after cancellation"),
    });
    const reader = (await handle(context)).body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("releases if tool setup fails", async () => {
    const release = vi.fn(async () => {});
    const handle = createEdgeOneAgentHandler({
      authorize: async () => user,
      acquireUsage: async () => ({ maxRunSeconds: 300, release }),
      createModelRuntime: async () => runtime(),
      tools: async () => { throw new Error("tools unavailable"); },
    });
    expect((await handle(context)).status).toBe(503);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("aborts timed out model work and releases before the terminal error", async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    vi.spyOn(agentRuntime, "runPlatformAgent").mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const handle = createEdgeOneAgentHandler({
      authorize: async () => user,
      acquireUsage: async () => ({ maxRunSeconds: 30, release }),
      createModelRuntime: async () => runtime(),
    });
    const response = await handle(context);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await response.text()).toContain("AI 回答生成超时");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
