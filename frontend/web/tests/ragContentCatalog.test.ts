import type { JojoCatalog } from "@jojo/content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalog: JojoCatalog = {
  formatVersion: "jojo-catalog/1",
  revision: 1,
  updatedAt: "2026-09-06T00:00:00Z",
  datasets: [],
};

describe("content catalog loading", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("fetches a fresh catalog after the first request fails", async () => {
    const { JoxClient } = await import("@jojo/content");
    const fetchJson = vi.spyOn(JoxClient.prototype, "fetchJson")
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(catalog);
    const { loadCatalog } = await import("../src/rag/content");

    await expect(loadCatalog()).rejects.toThrow("network unavailable");
    await expect(loadCatalog()).resolves.toEqual(catalog);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson).toHaveBeenLastCalledWith("catalog.jox", undefined, "no-store");
  });

  it("shares pending requests and keeps a successfully loaded catalog", async () => {
    const { JoxClient } = await import("@jojo/content");
    let resolveCatalog!: (value: JojoCatalog) => void;
    const response = new Promise<JojoCatalog>((resolve) => { resolveCatalog = resolve; });
    const fetchJson = vi.spyOn(JoxClient.prototype, "fetchJson").mockReturnValue(response);
    const { loadCatalog } = await import("../src/rag/content");

    const first = loadCatalog();
    const second = loadCatalog();
    expect(fetchJson).toHaveBeenCalledOnce();

    resolveCatalog(catalog);
    await expect(Promise.all([first, second])).resolves.toEqual([catalog, catalog]);
    await expect(loadCatalog()).resolves.toEqual(catalog);
    expect(fetchJson).toHaveBeenCalledOnce();
  });
});
