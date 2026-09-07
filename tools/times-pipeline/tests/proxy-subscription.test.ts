import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadSubscription, SubscriptionDownloadError, subscriptionFailure } from "../src/proxy-subscription.js";

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
    expect(JSON.stringify(log.mock.calls)).toContain('\\"httpStatus\\":503');
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

  it("reports allowlisted nested DNS/socket codes without exposing cause messages or arbitrary codes", async () => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const error = new TypeError("https://private.example/secret", { cause: new AggregateError([
      Object.assign(new Error("node-password"), { code: "ENOTFOUND" }),
      Object.assign(new Error("Authorization: secret"), { code: "ECONNRESET" }),
      { code: "SECRET_TOKEN_custom", message: "secret" },
    ], "private secret") });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    const failure = await downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 }).catch((e) => e);
    expect(failure).toBeInstanceOf(SubscriptionDownloadError);
    expect(failure.failure).toEqual({ kind: "network", networkCodes: ["ECONNRESET", "ENOTFOUND"], retryable: true });
    expect(failure.cause).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.at(-1)?.[0]).toContain('"retrying":false');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|password|SECRET_TOKEN/);
  });

  it.each([408, 429, 500, 502, 503, 504])("keeps exhausted HTTP %s eligible for cache fallback", async (status) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("private body", { status }));
    const error = await downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 }).catch((e) => e);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(error.failure).toEqual({ kind: "http", httpStatus: status, networkCodes: [], retryable: true });
  });

  it("does not hide TLS certificate failures behind retries or cached credentials", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("secret", {
      cause: Object.assign(new Error("private"), { code: "CERT_HAS_EXPIRED" }),
    }));
    const error = await downloadSubscription("https://private.example/secret", { fetcher, delayMs: 0 }).catch((e) => e);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(error.failure.retryable).toBe(false);
    expect(error.failure.networkCodes).toEqual(["CERT_HAS_EXPIRED"]);
  });

  it("bounds cyclic cause traversal and reports timeout categories", () => {
    const error = Object.assign(new Error("secret"), { code: "EAI_AGAIN", cause: {} });
    error.cause = error;
    expect(subscriptionFailure(error).networkCodes).toEqual(["EAI_AGAIN"]);
    expect(subscriptionFailure(new DOMException("private", "AbortError")))
      .toEqual({ kind: "timeout", networkCodes: [], retryable: true });
    expect(subscriptionFailure(new TypeError("private", {
      cause: { code: "ERR_TLS_UNKNOWN_PRIVATE_VALUE" },
    }))).toEqual({ kind: "network", networkCodes: [], retryable: false });
  });
});
