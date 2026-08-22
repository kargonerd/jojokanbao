import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("../src/account/auth", () => ({
  authClient: { auth: { getSession } },
}));

import { timesApi } from "../src/times/api";

afterEach(() => {
  vi.unstubAllGlobals();
  getSession.mockReset();
});

describe("same-origin business APIs", () => {
  it("routes Times through the unified Reader API namespace", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "reader-token" } }, error: null });
    const fetchMock = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await timesApi.listNews();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/times/news?limit=100", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer reader-token" }),
    }));
  });

  it("does not call Times without a signed-in session", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(timesApi.listNews()).rejects.toThrow("请先登录后使用时事");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an HTML fallback instead of letting Times render a blank screen", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "reader-token" } }, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })));

    await expect(timesApi.listNews()).rejects.toThrow("服务暂时不可用");
  });
});
