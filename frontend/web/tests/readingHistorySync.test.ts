import { describe, expect, it } from "vitest";
import { recentBookResume, recentIssuePage, type RecentReadingItem } from "../src/library/recentReadingStore";
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

describe("resume from a saved record", () => {
  const book = (overrides: Partial<RecentReadingItem> = {}): RecentReadingItem => ({
    id: "book:example:book", kind: "book", datasetId: "example", itemKey: "book",
    title: "示例书", subtitle: "第二章", href: "/book/example/book?chapter=two&position=0.4",
    progress: 40, updatedAt: 100, ...overrides,
  });

  it("restores the chapter and position of a book", () => {
    expect(recentBookResume([book()], "example", "book")).toEqual({ chapterId: "two", position: 0.4 });
    expect(recentBookResume([book({ chapterProgress: 0.75 })], "example", "book")).toEqual({ chapterId: "two", position: 0.75 });
  });

  it("reopens the chapter start for records saved before positions existed", () => {
    expect(recentBookResume([book({ href: "/book/example/book?chapter=two" })], "example", "book"))
      .toEqual({ chapterId: "two", position: 0 });
  });

  it("ignores books without a recorded chapter and other books", () => {
    expect(recentBookResume([book({ href: "/book/example/book" })], "example", "book")).toBeUndefined();
    expect(recentBookResume([book()], "example", "other")).toBeUndefined();
  });

  it("restores the page of an issue opened from its deep link", () => {
    const issue: RecentReadingItem = {
      id: "periodical:rmrb:19761009", kind: "periodical", publicationId: "rmrb",
      title: "人民日报", subtitle: "", href: "/archive/rmrb/19761009#page-4",
      progress: 0, updatedAt: 100, totalPages: 6,
    };
    expect(recentIssuePage([issue], "rmrb", "19761009")).toBe(4);
    expect(recentIssuePage([issue], "rmrb", "19761010")).toBeUndefined();
  });
});
