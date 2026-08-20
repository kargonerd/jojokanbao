import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogApi } from "../src/rag/api";
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

  it("routes RAG through the unified Reader API namespace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await catalogApi.listNotebooks();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/rag/catalog/notebooks", expect.objectContaining({ method: "GET" }));
  });
});
