import { describe, expect, it } from "vitest";
import { filterPublicationWindow } from "../src/discovery/publication-window.js";
import { publisherDate } from "../src/text.js";
import type { Candidate } from "../src/types.js";

function candidate(articleId: string, publishedAt: string): Candidate {
  return {
    articleId,
    sourceId: "example",
    sourceName: "Example",
    language: "en",
    sourceUrl: `https://example.test/${articleId}`,
    canonicalUrl: `https://example.test/${articleId}`,
    title: articleId,
    contentStatus: "metadata",
    publishedAt,
    authors: [],
    publisherCategories: [],
  };
}

describe("publisher time normalization", () => {
  it("interprets publisher wall-clock timestamps in their declared IANA zones", () => {
    expect(publisherDate("2026-08-26 20:13:58", "Asia/Shanghai", "wall-clock"))
      .toBe("2026-08-26T12:13:58.000Z");
    expect(publisherDate("2026-08-26T20:13:58.000Z", "Asia/Shanghai", "wall-clock"))
      .toBe("2026-08-26T12:13:58.000Z");
    expect(publisherDate("2026-07-15 08:30:00", "America/New_York"))
      .toBe("2026-07-15T12:30:00.000Z");
    expect(publisherDate("2026-01-15 08:30:00", "America/New_York"))
      .toBe("2026-01-15T13:30:00.000Z");
    expect(publisherDate("26 Aug 2026 08:30:00", "Europe/London"))
      .toBe("2026-08-26T07:30:00.000Z");
    expect(publisherDate("Published on 26/08/2026 - 10:34", "America/Sao_Paulo", "wall-clock"))
      .toBe("2026-08-26T13:34:00.000Z");
  });

  it("preserves explicit offsets and numeric epochs", () => {
    expect(publisherDate("2026-08-26T08:30:00-04:00", "America/New_York"))
      .toBe("2026-08-26T12:30:00.000Z");
    expect(publisherDate(1_788_236_200_000, "Asia/Tokyo"))
      .toBe(new Date(1_788_236_200_000).toISOString());
  });

  it("enforces both sides of a discovery window with bounded clock skew", () => {
    const result = filterPublicationWindow([
      candidate("old", "2026-08-26T12:32:12.000Z"),
      candidate("inside", "2026-08-26T12:40:00.000Z"),
      candidate("skew", "2026-08-26T12:43:30.000Z"),
      candidate("future", "2026-08-26T14:08:00.000Z"),
    ], {
      startedAt: "2026-08-26T12:42:14.000Z",
      sinceHours: 0.167,
      futureToleranceSeconds: 120,
    });

    expect(result.candidates.map((value) => value.articleId)).toEqual(["inside", "skew"]);
    expect(result.window).toMatchObject({ accepted: 2, beforeWindow: 1, afterWindow: 1 });
    expect(result.window.anomalies).toEqual([expect.objectContaining({ articleId: "future", reason: "after-window" })]);
  });
});
