import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadSubscription } from "../src/proxy-subscription.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("proxy subscription transport", () => {
  it("retries network and server failures without logging credentials", async () => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("https://private.example/secret"))
      .mockResolvedValueOnce(new Response("secret", { status: 503 }))
      .mockResolvedValueOnce(new Response("proxies: []"));
    await expect(downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 }))
      .resolves.toBe("proxies: []");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret/);
  });

  it.each([401, 403, 404])("does not retry HTTP %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private credential", { status }));
    await expect(downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 }))
      .rejects.toThrow(/^Unable to download the configured proxy subscription$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caps attempts, including hung connections", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("secret", "AbortError")));
    }));
    const result = expect(downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 }))
      .rejects.toThrow(/^Unable to download the configured proxy subscription$/);
    await vi.runAllTimersAsync();
    await result;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("cancels oversized responses without retrying", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20_000_001)); },
      cancel,
    })));
    await expect(downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });
});
