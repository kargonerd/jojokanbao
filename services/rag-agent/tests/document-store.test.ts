import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore, normalizeForSearch } from "../src/document-store.js";

describe("DocumentStore", () => {
  let directory: string;
  let store: DocumentStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jojo-rag-agent-"));
    store = new DocumentStore(directory);
    await store.initialize();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("adds a Markdown document and infers its title", async () => {
    const document = await store.add({
      originalName: "history.md",
      content: Buffer.from("# 革命造反年代\n\n李遜\n"),
    });

    expect(document.title).toBe("革命造反年代");
    expect(document.lineCount).toBe(4);
    expect(await store.list()).toEqual([document]);
  });

  it("matches simplified queries against traditional source text", async () => {
    const document = await store.add({
      originalName: "history.md",
      content: Buffer.from("# 上海文革運動史稿\n\n工人造反派參與了運動。\n"),
    });

    const hits = await store.search([document.id], ["运动", "参与"], 4);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.excerpt).toContain("工人造反派參與了運動");
    expect(hits[0]?.matchedQueries).toEqual(["运动", "参与"]);
    expect(normalizeForSearch("運動")).toBe(normalizeForSearch("运动"));
  });

  it("enforces read range limits", async () => {
    const document = await store.add({
      originalName: "long.md",
      content: Buffer.from(Array.from({ length: 240 }, (_, index) => `第 ${index + 1} 行`).join("\n")),
    });

    await expect(store.readLines(document.id, 1, 201)).rejects.toThrow("单次最多读取 200 行");
    await expect(store.readLines("outside", 1, 2)).rejects.toThrow("所选文档不存在");
  });

  it("keeps coverage for each query when a common term has many early hits", async () => {
    const document = await store.add({
      originalName: "coverage.md",
      content: Buffer.from([
        "運動開端",
        ...Array.from({ length: 20 }, (_, index) => `第 ${index + 2} 次運動`),
        ...Array.from({ length: 10 }, (_, index) => `間隔行 ${index + 1}`),
        "幹部參與了群眾組織",
      ].join("\n")),
    });

    const hits = await store.search([document.id], ["运动", "参与"], 2);

    expect(hits).toHaveLength(2);
    expect(hits.some((hit) => hit.matchedQueries.includes("运动"))).toBe(true);
    expect(hits.some((hit) => hit.matchedQueries.includes("参与"))).toBe(true);
  });

  it("prefers an informative paragraph over an early table-of-contents hit", async () => {
    const document = await store.add({
      originalName: "ranking.md",
      content: Buffer.from([
        "# 目录",
        "二兵团",
        ...Array.from({ length: 12 }, () => ""),
        "二兵团在事件后迅速发展，并形成了多个地区分部；这一段包含可用于回答问题的具体经过和结果。",
      ].join("\n")),
    });

    const [hit] = await store.search([document.id], ["二兵团"], 1);

    expect(hit?.excerpt).toContain("这一段包含可用于回答问题的具体经过和结果");
  });
});
