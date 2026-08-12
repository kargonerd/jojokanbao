import { describe, expect, it } from "vitest";
import { decodeWereadParts, hashWereadId, inspectWereadCompleteness } from "../src";

describe("WeRead transport decoder", () => {
  it("decodes a minimally wrapped Base64 payload", () => {
    expect(decodeWereadParts([`${"A".repeat(32)}xSGk`])).toBe("Hi");
  });

  it("generates the cid used by WeRead chapter responses", () => {
    expect(hashWereadId(36)).toBe("19c3222022419ca14e7eef7");
  });

  it("detects TOC entries whose chapter responses are missing", () => {
    const result = inspectWereadCompleteness({
      meta: { chapterSize: 5, lastChapterIdx: 5 },
      toc: [
        { chapterUid: 1, chapterIdx: 1, level: 1, title: "封面" },
        { chapterUid: 2, chapterIdx: 2, level: 1, title: "第一章" },
        { chapterUid: 3, chapterIdx: 3, level: 1, title: "第二章" },
        { chapterUid: 4, chapterIdx: 4, level: 1, title: "第三章" },
      ],
      chapters: [
        { cid: hashWereadId(2) },
        { cid: hashWereadId(4) },
        { cid: hashWereadId(4) },
        { cid: "not-in-toc" },
      ],
    });

    expect(result).toMatchObject({
      declaredTocItems: 5,
      missingTocItems: 1,
      expectedChapterRecords: 3,
      presentChapterRecords: 2,
      missingChapterRecords: 1,
      unmatchedChapterRecords: 1,
      duplicateChapterRecords: 1,
      chapterCoverage: 2 / 3,
      missingChapters: [{ chapterUid: "3", title: "第二章", order: 3 }],
    });
  });
});
