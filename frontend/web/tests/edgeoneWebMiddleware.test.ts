import { describe, expect, it, vi } from "vitest";
import { middleware } from "../../../infrastructure/edgeone/web-middleware";

describe("EdgeOne Web beta middleware", () => {
  it("leaves the production response unchanged", async () => {
    const original = new Response("production", {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
    const next = vi.fn(() => original);
    const response = await middleware({
      request: new Request("https://www.jojokanbao.cn/"),
      next,
    });

    expect(response).toBe(original);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it("serves the beta domain publicly with a noindex response header", async () => {
    const next = vi.fn(() => new Response("redesign", {
      status: 200,
      headers: { "Cache-Control": "public, max-age=3600" },
    }));
    const response = await middleware({
      request: new Request("https://beta.jojokanbao.cn/library"),
      next,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("redesign");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it("matches the beta hostname case-insensitively", async () => {
    const response = await middleware({
      request: new Request("https://BETA.JOJOKANBAO.CN/search"),
      next: vi.fn(() => new Response(null, { status: 204 })),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });
});
