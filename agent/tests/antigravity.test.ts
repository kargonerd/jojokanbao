import { afterEach, describe, expect, it, vi } from "vitest";
import { Type, type OAuthCredential } from "@earendil-works/pi-ai";
import { JsonCredentialStore, PersistentCredentialStore, type CredentialFile } from "../src/credentials";
import { createPlatformModelRuntime, createPlatformModels, resolvePlatformModelConfig, modelRuntimeStream } from "../src/models";
import { refreshAntigravityCredential } from "../src/antigravity/auth";
import { runPlatformAgent } from "../src/runtime";
import { resetAntigravityCatalogForTests } from "pi-antigravity/src/models/models.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expired: OAuthCredential = {
  type: "oauth", access: "old-access", refresh: "refresh-secret", expires: 0,
  projectId: "test-project", generation: 3,
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
const sse = (parts: unknown[], finishReason = "STOP") => new Response(
  `data: ${JSON.stringify({ response: {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
  } })}\n\n`,
  { headers: { "Content-Type": "text/event-stream" } },
);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAntigravityCatalogForTests(); });

describe("Antigravity package adapter", () => {
  it("refreshes once across simultaneous requests and persists tokens across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jojo-antigravity-"));
    try {
      const path = join(dir, "auth.json");
      const store = new JsonCredentialStore(path);
      await store.modify("antigravity", async () => expired);
      await store.modify("openai-codex", async () => ({ ...expired, access: "codex-access" }));
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(String(_url)).toBe("https://oauth2.googleapis.com/token");
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(expired.refresh);
        return json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 });
      });
      vi.stubGlobal("fetch", fetch);
      const first = createPlatformModels({ credentials: store });
      const second = createPlatformModels({ credentials: new JsonCredentialStore(path) });
      const auth = await Promise.all([first.getAuth("antigravity"), second.getAuth("antigravity")]);
      expect(fetch).toHaveBeenCalledOnce();
      for (const item of auth) expect(JSON.parse(item!.auth.apiKey!)).toEqual({ token: "fresh-access", projectId: "test-project" });
      const persisted = new JsonCredentialStore(path);
      expect(await persisted.read("antigravity")).toMatchObject({
        access: "fresh-access", refresh: "rotated-refresh", projectId: "test-project", generation: 3,
      });
      expect(await persisted.read("openai-codex")).toMatchObject({ access: "codex-access" });
      await createPlatformModels({ credentials: persisted }).getAuth("antigravity");
      expect(fetch).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps the Google refresh token when the response does not rotate it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ access_token: "fresh-access", expires_in: 3600 })));
    const next = await refreshAntigravityCredential(expired);
    expect(next).toMatchObject({ refresh: expired.refresh, projectId: expired.projectId, generation: 3, type: "oauth" });
    expect(next.expires).toBeGreaterThan(Date.now() + 3000_000);
  });

  it.each([400, 503])("preserves the credential after HTTP %s and hides endpoint details", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant", error_description: "private-provider-detail" }, status)));
    let saved: CredentialFile = { antigravity: expired };
    const write = vi.fn(async (value: CredentialFile) => { saved = value; });
    const models = createPlatformModels({ credentials: new PersistentCredentialStore({ read: async () => saved, write }) });
    await expect(models.getAuth("antigravity")).rejects.toThrow("Antigravity OAuth refresh failed");
    await expect(models.getAuth("antigravity")).rejects.not.toThrow("private-provider-detail");
    expect(write).not.toHaveBeenCalled();
    expect(saved.antigravity).toEqual(expired);
  });

  it("rejects incomplete refresh responses and respects caller cancellation", async () => {
    const fetch = vi.fn(async () => json({ access_token: "", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetch);
    await expect(refreshAntigravityCredential(expired)).rejects.toThrow("refresh failed");
    fetch.mockClear();
    await expect(refreshAntigravityCredential(expired, AbortSignal.abort())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a pending token request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort(new Error("cancelled-test"));
    })));
    await expect(refreshAntigravityCredential(expired, controller.signal)).rejects.toThrow("cancelled-test");
  });

  it.each([
    ["gemini-3.1-pro", "gemini-3.1-pro-low", 65535],
    ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite", 65535],
    ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite", 65535],
  ] as const)("executes a Pi tool round trip with %s and an accepted output limit", async (model, requestModel, maxOutputTokens) => {
    let requestCount = 0;
    const requests: Record<string, any>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (String(_url).includes("fetchAvailableModels")) {
        return json({ models: { [model]: { displayName: model } } });
      }
      expect(String(_url)).toContain("streamGenerateContent");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer valid-access");
      requests.push(JSON.parse(String(init?.body)));
      requestCount += 1;
      return requestCount === 1
        ? sse([{ functionCall: { id: "tool-1", name: "lookup_book", args: { id: "book-1" } }, thoughtSignature: "c2lnbmF0dXJl" }])
        : sse([{ text: "查到《测试馆藏》，编号 book-1。" }]);
    }));
    const credentials = new PersistentCredentialStore({
      read: async () => ({ antigravity: { ...expired, access: "valid-access", expires: Date.now() + 3600_000 } }),
      write: async () => { throw new Error("A fresh credential must not be refreshed"); },
    });
    const runtime = await createPlatformModelRuntime({
      config: resolvePlatformModelConfig({ JOJO_AGENT_PROVIDER: "antigravity", JOJO_AGENT_MODEL: model }), credentials,
    });
    const execute = vi.fn(async (_id: string, args: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ id: (args as { id: string }).id, title: "测试馆藏" }) }], details: {},
    }));
    const result = await runPlatformAgent({
      systemPrompt: "Use lookup_book to answer.", prompt: "查询 book-1", sessionId: "test-session",
      model: runtime.model, stream: modelRuntimeStream(runtime), reasoning: "low", maxTurns: 3,
      tools: [{ name: "lookup_book", label: "Lookup book", description: "Look up one book", parameters: Type.Object({ id: Type.String() }), execute }],
    });
    expect(result.answer).toContain("测试馆藏");
    expect(result.toolCalls).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.model).toBe(requestModel);
    expect(requests[0]!.request.generationConfig.maxOutputTokens).toBe(maxOutputTokens);
    expect(requests[1]!.request.contents.some((content: any) => content.parts.some((part: any) => part.functionResponse?.name === "lookup_book"))).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
