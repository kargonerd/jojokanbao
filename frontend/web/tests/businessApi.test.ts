import { afterEach, describe, expect, it, vi } from "vitest";
import { timesApi } from "../src/times/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("same-origin business APIs", () => {
  it("routes Times through the unified Reader API namespace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await timesApi.listNews();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/times/news?limit=100", expect.objectContaining({ method: "GET" }));
  });

  it("rejects an HTML fallback instead of letting Times render a blank screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })));

    await expect(timesApi.listNews()).rejects.toThrow("服务暂时不可用");
  });
});
