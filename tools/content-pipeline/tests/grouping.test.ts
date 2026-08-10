import { describe, expect, it } from "vitest";
import {
  chineseNumber,
  groupBookTitle,
  splitChapterRanges,
} from "../src";

describe("book Dataset grouping", () => {
  it("parses Chinese volume numbers", () => {
    expect(chineseNumber("四")).toBe(4);
    expect(chineseNumber("二十八")).toBe(28);
    expect(chineseNumber("一百二十")).toBe(120);
    expect(chineseNumber("37")).toBe(37);
  });

  it("groups separately exported volumes into one source-neutral Dataset", () => {
    const first = groupBookTitle("马克思恩格斯全集（第一卷）");
    const second = groupBookTitle("马克思恩格斯全集（第二十八卷）");
    expect(first.datasetTitle).toBe("马克思恩格斯全集");
    expect(first.datasetId).toBe(second.datasetId);
    expect(first.sourceVolumeNumber).toBe(1);
    expect(second.sourceVolumeNumber).toBe(28);
  });

  it("recognizes all-in-one multi-volume titles", () => {
    expect(groupBookTitle("毛泽东文集（全八卷）")).toMatchObject({
      datasetTitle: "毛泽东文集",
      datasetType: "book-series",
      declaredTotalVolumes: 8,
    });
    expect(groupBookTitle("资本论（纪念版）全三卷")).toMatchObject({
      datasetTitle: "资本论(纪念版)",
      declaredTotalVolumes: 3,
    });
    expect(groupBookTitle("毛泽东选集（1-5卷）")).toMatchObject({
      datasetTitle: "毛泽东选集",
      declaredTotalVolumes: 5,
    });
  });

  it("splits chapter ranges on volume navigation markers", () => {
    const chapters = [0, 1, 2, 3, 4].map((order) => ({
      id: `chapter:${order}`,
      order,
      title: order === 1 ? "第一卷" : order === 3 ? "第二卷" : `第${order}章`,
      body: { format: "text" as const, value: `正文${order}` },
      assetRefs: [],
    }));
    const ranges = splitChapterRanges(chapters, [
      { id: "toc:1", order: 1, title: "第一卷", targetId: "chapter:1" },
      { id: "toc:2", order: 2, title: "第二卷", targetId: "chapter:3" },
    ], 2);
    expect(ranges.map((range) => [range.volumeNumber, [...range.chapterIds]])).toEqual([
      [1, ["chapter:0", "chapter:1", "chapter:2"]],
      [2, ["chapter:3", "chapter:4"]],
    ]);
  });

  it("does not invent volumes when an all-in-one export is incomplete", () => {
    const chapters = [
      { id: "chapter:1", order: 1, title: "文集（第一卷）", body: { format: "text" as const, value: "一" }, assetRefs: [] },
      { id: "chapter:2", order: 2, title: "文集（第二卷）", body: { format: "text" as const, value: "二" }, assetRefs: [] },
      { id: "chapter:3", order: 3, title: "第五卷说明", body: { format: "text" as const, value: "说明" }, assetRefs: [] },
    ];
    expect(splitChapterRanges(chapters, [], 5)).toEqual([]);
  });

  it("uses the first complete-work marker instead of nested volume references", () => {
    const chapters = [
      { id: "chapter:1", order: 1, title: "全集 第一卷", body: { format: "text" as const, value: "一" }, assetRefs: [] },
      { id: "chapter:2", order: 2, title: "全集 第二卷", body: { format: "text" as const, value: "二" }, assetRefs: [] },
      { id: "chapter:3", order: 3, title: "第一卷", body: { format: "text" as const, value: "内嵌一" }, assetRefs: [] },
      { id: "chapter:4", order: 4, title: "第二卷", body: { format: "text" as const, value: "内嵌二" }, assetRefs: [] },
    ];
    const ranges = splitChapterRanges(chapters, [], 2);
    expect(ranges.map((range) => [...range.chapterIds])).toEqual([
      ["chapter:1"],
      ["chapter:2", "chapter:3", "chapter:4"],
    ]);
  });
});
