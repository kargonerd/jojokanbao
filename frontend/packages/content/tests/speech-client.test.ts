import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechClient, DEFAULT_SPEECH_PROVIDERS, SPEECH_PROVIDERS_ERROR } from "../src/speech-client";

const client = createSpeechClient({ allowed: () => true, apiUrl: (path) => path, digest: async () => "" });
const capabilities = { defaultProvider: "auto", providers: DEFAULT_SPEECH_PROVIDERS };

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("speech capabilities", () => {
  it.each([
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => Promise.resolve(new Response(null, { status: 503 })),
    () => Promise.resolve(new Response("<html>proxy error</html>")),
    () => Promise.resolve(Response.json({ providers: [null] })),
    () => Promise.resolve(Response.json({ providers: [] })),
  ])("gives a consistent recoverable error without substituting voices", async (response) => {
    const fetcher = vi.fn().mockImplementationOnce(response).mockResolvedValueOnce(Response.json(capabilities));
    vi.stubGlobal("fetch", fetcher);
    await expect(client.loadSpeechProviders()).rejects.toThrow(SPEECH_PROVIDERS_ERROR);
    await expect(client.loadSpeechProviders()).resolves.toEqual(capabilities);
  });

  it("aborts a stalled request so the player can leave loading", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = expect(client.loadSpeechProviders()).rejects.toThrow(SPEECH_PROVIDERS_ERROR);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("preserves caller cancellation instead of reporting a service error", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    })));
    const controller = new AbortController();
    const result = expect(client.loadSpeechProviders(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
  });
});
