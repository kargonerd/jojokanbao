import { beforeEach, describe, expect, it, vi } from "vitest";

const content = vi.hoisted(() => ({
  loadCatalog: vi.fn(),
  loadDataset: vi.fn(),
}));

vi.mock("../src/rag/content", () => content);

import { notebookApi } from "../src/rag/api";

describe("AI Dataset catalog", () => {
  beforeEach(() => {
    content.loadCatalog.mockReset();
  });

  it("only exposes published Datasets with explicit AI support", async () => {
    content.loadCatalog.mockResolvedValue({
      formatVersion: "jojo-catalog/1",
      revision: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
      datasets: [
        { datasetId: "book", type: "book", title: "书籍", language: "zh-CN", indexObject: "content/books/book/index.jox", publicationStatus: "published", aiEnabled: true },
        { datasetId: "rmrb", type: "newspaper", title: "人民日报", language: "zh-CN", indexObject: "content/newspapers/rmrb/index.jox", publicationStatus: "published" },
        { datasetId: "times", type: "newspaper", title: "JOJO 时事", language: "mul", indexObject: "content/newspapers/times/index.jox", publicationStatus: "published", aiEnabled: false },
        { datasetId: "draft", type: "book", title: "草稿书", language: "zh-CN", indexObject: "content/books/draft/index.jox", publicationStatus: "draft", aiEnabled: true },
      ],
    });

    await expect(notebookApi.list()).resolves.toEqual([
      expect.objectContaining({ id: "book", title: "书籍", aiEnabled: true }),
    ]);
  });
});
