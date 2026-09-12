import { describe, expect, it } from "vitest";
import { recentItemToRecord, readingRecordToRecentItem } from "../src/library/readingHistorySync";

describe("portable reading links", () => {
  it("round trips a native book record with encoded identity and chapter position", () => {
    const record = { kind: "book" as const, datasetId: "书 集", itemKey: "volume/1", chapterId: "章&二", chapterProgress: 0.75, title: "书", subtitle: "章", progress: 45, updatedAt: 100 };
    const recent = readingRecordToRecentItem(record);
    expect(recent.href).toContain("/book/%E4%B9%A6%20%E9%9B%86/volume%2F1?");
    expect(recentItemToRecord(recent)).toEqual(record);
  });
  it("converts PDF page links without carrying arbitrary URLs between devices", () => {
    const record = { kind: "periodical" as const, publication: "rmrb" as const, issueId: "19761009", currentPage: 4, totalPages: 6, title: "人民日报", subtitle: "", progress: 0, updatedAt: 100 };
    expect(readingRecordToRecentItem(record).href).toBe("/archive/rmrb/19761009#page-4");
    expect(recentItemToRecord(readingRecordToRecentItem(record))).toEqual(record);
  });
});
