import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeSignup } from "../src/signup";

const URL = "https://reader.jojokanbao.cn/api/v1/account/signup-authorization";

afterEach(() => vi.unstubAllGlobals());

describe("authorizeSignup", () => {
  it("reads the authorization without requiring AbortSignal.timeout", async () => {
    // React Native installs an abort-controller polyfill that has no static
    // timeout, so the deadline must not depend on it.
    const signals = AbortSignal as unknown as { timeout?: (milliseconds: number) => AbortSignal };
    const timeout = signals.timeout;
    delete signals.timeout;
    const fetch = vi.fn().mockResolvedValue(Response.json({ authorization: "receipt" }));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(authorizeSignup(URL, "reader@example.com", " ABC123 ")).resolves.toBe("receipt");
      expect(fetch).toHaveBeenCalledWith(URL, expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "reader@example.com", invitationCode: "ABC123" }),
      }));
    } finally {
      signals.timeout = timeout;
    }
  });

  it("surfaces the backend error code instead of a parse error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(
      { error: { code: "remote_config_unavailable", message: "运行配置暂时无法读取，请稍后重试。" } },
      { status: 503 },
    )));

    await expect(authorizeSignup(URL, "reader@example.com")).rejects.toMatchObject({
      code: "remote_config_unavailable", status: 503,
    });
  });

  it("reports a missing deployment or an offline network as an unavailable service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html><p>NOT_FOUND</p>", {
      status: 404, headers: { "content-type": "text/html" },
    })));
    await expect(authorizeSignup(URL, "reader@example.com")).rejects.toMatchObject({
      status: 404, message: "注册服务暂时不可用，请稍后重试。",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(authorizeSignup(URL, "reader@example.com")).rejects.toMatchObject({
      code: "signup_service_unreachable",
    });
  });
});
